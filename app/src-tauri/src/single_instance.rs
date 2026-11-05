//! 一个数据目录只跑一个启动器：再次启动时把已有窗口叫到前台，新进程随后退出；已有的那个正在退出时，
//! 等它退出后接手。
//!
//! 实例锁、任务队列、游戏会话都只在进程内互斥，两个进程共用一份数据时谁也看不见谁：同一个实例能同时装两遍、
//! 启动两遍，`config.json` 按谁后写为准。所以按数据目录占位，而不是按应用标识：两份便携版的数据互不相干，
//! 可以各开各的。
//!
//! 占位与唤醒是同一个具名事件：由系统保证只有一个进程创建成功，进程退出（包括崩溃）后系统回收，
//! 下一次启动不会被残留挡住。后来者对它 `SetEvent`，先来者的监听线程醒来把窗口叫到前台。事件自动复位，
//! 先来者还没开始监听时的那次唤醒留到开始监听时生效。
//!
//! 叫到了前台，先来者再置另一个具名事件应答，后来者收到才退出。先来者正在退出时（窗口已关，退出收尾还要
//! 落几秒盘）叫不到窗口，也就不应答；后来者等它退出、占位被系统回收后自己接手，不然双击之后什么都打不开。
//! 先来者退出之前不接手：两个进程不能同时写一份数据。

use std::path::Path;
use std::time::{Duration, Instant};

use petalfall_base::brand::APP_NAME_EN;
use windows::Win32::Foundation::{
    CloseHandle, GetLastError, SetLastError, ERROR_ALREADY_EXISTS, ERROR_SUCCESS, HANDLE,
    WAIT_EVENT, WAIT_OBJECT_0, WAIT_TIMEOUT,
};
use windows::Win32::System::Threading::{
    CreateEventW, ResetEvent, SetEvent, WaitForSingleObject, INFINITE,
};
use windows_core::{HSTRING, PCWSTR};

/// 先来者既不应答也不退出时，后来者最多等这么久。要盖住先来者的整个退出收尾（各段时限之和，见
/// `the_takeover_wait_covers_the_exit_path`），等不到多半是它卡住了。
pub const TAKEOVER_WAIT: Duration = Duration::from_secs(15);

/// 后来者每隔这么久看一次应答、试一次占位。先来者退出后最多晚这么久接手。
const POLL: Duration = Duration::from_millis(100);

/// 这次启动在数据目录上的结果。
pub enum Claim {
    /// 这个数据目录上只有这一个启动器。
    First(Instance),
    /// 已有启动器在跑，它已经把窗口叫到前台，这个进程该退出了。
    Forwarded,
    /// 已有启动器占着，可在 [`TAKEOVER_WAIT`] 之内既没应答也没退出：卡住了，或是不会应答的旧版本（它照样
    /// 叫了窗口）。这个进程也退出，不和它同时用一份数据。
    Unanswered,
}

/// 关掉时释放的事件句柄。
struct Event(HANDLE);

// SAFETY: 事件句柄是进程级的内核对象句柄，不绑定创建它的线程。
unsafe impl Send for Event {}

impl Drop for Event {
    fn drop(&mut self) {
        // SAFETY: 句柄由 CreateEventW 创建、只在这里关闭一次
        if let Err(err) = unsafe { CloseHandle(self.0) } {
            tracing::warn!(error = %err, "关闭单实例事件句柄失败");
        }
    }
}

/// 打开具名的自动复位事件，不存在就新建。交回句柄与它是否已经存在。
fn open_event(name: &str) -> windows_core::Result<(Event, bool)> {
    let name = HSTRING::from(name);
    // SAFETY: 只写当前线程的错误码。成功的 CreateEventW 用它区分「新建」与「已存在」，先清掉，免得读到这个线程
    // 上一次调用留下的值：后来者要反复试占位，上一轮正是「已存在」
    unsafe { SetLastError(ERROR_SUCCESS) };
    // SAFETY: name 在调用期间有效；不带安全描述符，由系统给默认的
    let handle = unsafe { CreateEventW(None, false, false, PCWSTR(name.as_ptr())) }?;
    let event = Event(handle);
    // SAFETY: 读当前线程的错误码，中间没有别的系统调用
    let existed = unsafe { GetLastError() } == ERROR_ALREADY_EXISTS;
    Ok((event, existed))
}

/// 占着数据目录的事件与应答后来者的事件。监听线程持有它们活到进程退出。
pub struct Instance {
    claim: Event,
    answer: Event,
    waited_for_exit: Option<Duration>,
}

impl Instance {
    /// 这次启动时同一数据目录上的上一个启动器正在退出，等它退出用了多久；没等过是 `None`。
    pub fn waited_for_exit(&self) -> Option<Duration> {
        self.waited_for_exit
    }

    /// 在独立线程上等后来者，每来一次调用一次 `on_request`；它报告叫到了前台才应答，后来者据此退出。
    pub fn listen(self, on_request: impl Fn() -> bool + Send + 'static) -> std::io::Result<()> {
        std::thread::Builder::new()
            .name("single-instance".to_owned())
            .spawn(move || loop {
                let woken = self.wait();
                if woken != WAIT_OBJECT_0 {
                    tracing::error!(
                        code = woken.0,
                        "等后来者的事件失效，之后再次启动不会把窗口叫到前台"
                    );
                    return;
                }
                if !on_request() {
                    continue;
                }
                // SAFETY: answer 是本结构持有的有效句柄
                if let Err(err) = unsafe { SetEvent(self.answer.0) } {
                    tracing::error!(error = %err, "应答后来者失败，它要等到超时才退出");
                }
            })?;
        Ok(())
    }

    fn wait(&self) -> WAIT_EVENT {
        // SAFETY: claim 是本结构持有的有效句柄，线程结束前不会关闭
        unsafe { WaitForSingleObject(self.claim.0, INFINITE) }
    }
}

/// 按当前数据目录占位。
pub fn claim() -> Result<Claim, Box<dyn std::error::Error>> {
    let dir = petalfall_base::fs::data_dir()?;
    Ok(claim_name(&event_name(&dir), TAKEOVER_WAIT)?)
}

/// 事件名。名字里不能有反斜杠（它是命名空间分隔符）；Windows 路径不分大小写，同一个目录换种写法也要落到同一个名字上。
/// 用 `Local` 命名空间：别的登录会话是另一个用户，数据目录本来就是他自己的。
fn event_name(data_dir: &Path) -> String {
    let dir = data_dir.to_string_lossy().replace('\\', "/").to_lowercase();
    format!(r"Local\{APP_NAME_EN}-{dir}")
}

/// 应答事件名。`|` 不会出现在路径里，加在后面不会撞上另一个数据目录的占位名。
fn answer_name(claim: &str) -> String {
    format!("{claim}|answer")
}

/// 占位；已被占着就唤醒先来者，等它应答或退出，最多等 `wait`。
fn claim_name(name: &str, wait: Duration) -> windows_core::Result<Claim> {
    // 先于唤醒打开：先来者收到唤醒时，应答要落在后来者也拿着的这个对象上。
    let (answer, _) = open_event(&answer_name(name))?;
    let started = Instant::now();
    let mut asked = false;
    loop {
        let (claim, existed) = open_event(name)?;
        if !existed {
            return Ok(Claim::First(Instance {
                claim,
                answer,
                waited_for_exit: asked.then(|| started.elapsed()),
            }));
        }
        // 只唤醒一次：不会应答的旧版本每收到一次都会把窗口抢到前台，反复唤醒就是一直抢焦点。
        if !asked {
            // 清掉没人收的旧应答（等到超时才来的、旧版本后来者没收的），免得错当成这次的。
            // SAFETY: answer 与 claim 都是上面拿到的有效句柄
            unsafe { ResetEvent(answer.0) }?;
            // SAFETY: 同上
            unsafe { SetEvent(claim.0) }?;
            asked = true;
        }
        // 不拿着占位等：先来者退出时，只有所有句柄都关了系统才回收这个对象，后来者才占得到。
        drop(claim);
        // SAFETY: answer 是上面拿到的有效句柄
        match unsafe { WaitForSingleObject(answer.0, POLL.as_millis() as u32) } {
            WAIT_OBJECT_0 => return Ok(Claim::Forwarded),
            WAIT_TIMEOUT => {}
            _ => return Err(windows_core::Error::from_win32()),
        }
        if started.elapsed() >= wait {
            return Ok(Claim::Unanswered);
        }
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;
    use std::sync::mpsc;

    use super::*;

    /// 进程内的用例共用一个内核命名空间，名字带上进程号与用例名，并行跑、重复跑都不串。
    fn unique(test: &str) -> String {
        format!(r"Local\petalfall-test-{}-{test}", std::process::id())
    }

    /// 等得到应答的用例给足时限；等不到的用例只等这么久。
    const ENOUGH: Duration = Duration::from_secs(10);
    const BRIEF: Duration = Duration::from_millis(300);

    fn first(name: &str) -> Instance {
        match claim_name(name, BRIEF).unwrap() {
            Claim::First(instance) => instance,
            Claim::Forwarded | Claim::Unanswered => panic!("{name} 上不该已有启动器"),
        }
    }

    fn outcome(name: &str, wait: Duration) -> &'static str {
        match claim_name(name, wait).unwrap() {
            Claim::First(_) => "first",
            Claim::Forwarded => "forwarded",
            Claim::Unanswered => "unanswered",
        }
    }

    /// 起监听，每次唤醒报一次；`fronted` 是叫窗口的结果（窗口已关时为假）。
    fn listening(instance: Instance, fronted: bool) -> mpsc::Receiver<()> {
        let (tx, rx) = mpsc::channel();
        instance
            .listen(move || {
                tx.send(()).unwrap();
                fronted
            })
            .expect("起监听线程");
        rx
    }

    #[test]
    fn each_later_start_wakes_the_owner_once_and_leaves_on_its_answer() {
        let name = unique("wake");
        let woken = listening(first(&name), true);
        for _ in 0..3 {
            assert_eq!(outcome(&name, ENOUGH), "forwarded");
            woken
                .recv_timeout(Duration::from_secs(5))
                .expect("后来者要唤醒先来者");
        }
        assert!(
            woken.recv_timeout(Duration::from_millis(200)).is_err(),
            "事件自动复位，三次启动只醒三次"
        );
    }

    /// 窗口还没建好时就有人双击第二下：唤醒留在事件上，开始监听时才生效，不能丢；后来者等到那时的应答再走。
    #[test]
    fn a_start_before_listening_is_answered_once_listening_begins() {
        let name = unique("early");
        let instance = first(&name);
        let later = {
            let name = name.clone();
            std::thread::spawn(move || outcome(&name, ENOUGH))
        };
        std::thread::sleep(Duration::from_millis(300));
        let woken = listening(instance, true);
        woken
            .recv_timeout(Duration::from_secs(5))
            .expect("开始监听时要收到之前的那次唤醒");
        assert_eq!(later.join().unwrap(), "forwarded");
    }

    /// 先来者正在退出、叫不到窗口：不应答，后来者等它退出（这里用 drop 代替）后自己占位，记下等了多久。
    /// 新占的事件是干净的，不带着先前那次唤醒。
    #[test]
    fn a_start_while_the_owner_exits_takes_over_once_it_is_gone() {
        let name = unique("exiting");
        let owner = first(&name);
        let later = {
            let name = name.clone();
            std::thread::spawn(move || claim_name(&name, ENOUGH).unwrap())
        };
        std::thread::sleep(Duration::from_millis(300));
        drop(owner);
        let Claim::First(successor) = later.join().unwrap() else {
            panic!("先来者退出后，后来者应接手");
        };
        assert!(successor.waited_for_exit().is_some(), "等过先来者退出");
        assert!(
            listening(successor, true)
                .recv_timeout(Duration::from_millis(200))
                .is_err(),
            "接手后不该带着给先来者的那次唤醒"
        );
    }

    /// 先来者叫不到窗口、又一直不退出：后来者到时限就走，不和它同时用一份数据。等的这段时间只唤醒一次：
    /// 不会应答的旧版本每收到一次唤醒都会抢一次焦点。
    #[test]
    fn an_owner_that_neither_answers_nor_exits_is_woken_once_and_left_alone() {
        let name = unique("silent");
        let woken = listening(first(&name), false);
        assert_eq!(outcome(&name, BRIEF), "unanswered");
        woken
            .recv_timeout(Duration::from_secs(5))
            .expect("后来者要唤醒先来者");
        assert!(
            woken.recv_timeout(Duration::from_millis(200)).is_err(),
            "等应答期间不该反复唤醒"
        );
    }

    /// 上一个后来者没收走的应答不算数：先来者这回叫不到窗口，新来的后来者不能被旧应答打发走。
    #[test]
    fn a_stale_answer_does_not_send_a_later_start_away() {
        let name = unique("stale");
        let owner = first(&name);
        // SAFETY: answer 是 owner 持有的有效句柄
        unsafe { SetEvent(owner.answer.0) }.unwrap();
        let _woken = listening(owner, false);
        assert_eq!(outcome(&name, BRIEF), "unanswered");
    }

    #[test]
    fn other_data_dirs_are_left_alone() {
        let a = unique("dir-a");
        let b = unique("dir-b");
        let _first = first(&a);
        assert_eq!(outcome(&b, BRIEF), "first", "别的数据目录不受影响");
    }

    /// 进程退出（包括崩溃）时系统关掉句柄，这里用 drop 代替：占位跟着进程走，不留残留挡住下次启动。
    #[test]
    fn the_claim_ends_with_the_owner() {
        let name = unique("exit");
        drop(first(&name));
        let again = first(&name);
        assert_eq!(again.waited_for_exit(), None);
    }

    /// 后来者等先来者退出的时限要盖住退出收尾的各段时限之和，余下的留给 Tauri 自己的收尾与拉起安装程序。
    #[test]
    fn the_takeover_wait_covers_the_exit_path() {
        let exit_path = crate::commands::launch::EXIT_MARK_DEADLINE
            + crate::commands::accounts::ROTATIONS_EXIT_DEADLINE
            + crate::exit::PLAY_RECORDS_DEADLINE
            + crate::window_state::EXIT_DEADLINE;
        assert!(
            TAKEOVER_WAIT >= exit_path + Duration::from_secs(5),
            "退出收尾最长 {exit_path:?}，等先来者退出只给 {TAKEOVER_WAIT:?}"
        );
    }

    #[test]
    fn the_name_identifies_the_directory_not_its_spelling() {
        let lower = event_name(&PathBuf::from(r"d:\games\petalfall"));
        let upper = event_name(&PathBuf::from(r"D:\Games\Petalfall"));
        let forward = event_name(&PathBuf::from("D:/Games/Petalfall"));
        assert_eq!(lower, upper);
        assert_eq!(lower, forward);
        assert_ne!(lower, event_name(&PathBuf::from(r"D:\Games\Other")));
        assert_eq!(
            lower.matches('\\').count(),
            1,
            "除了 Local 这个前缀不能再有反斜杠：{lower}"
        );
        assert!(lower.starts_with("Local\\"), "{lower}");
    }

    /// 真正创建一次，确认这种名字系统收：中文路径与空格都常见，应答名多出的 `|` 也要收。
    #[test]
    fn real_data_dir_names_are_accepted_by_the_system() {
        let dir = format!(r"D:\游戏 目录\{}\Petalfall", std::process::id());
        let name = event_name(&PathBuf::from(dir));
        let _woken = listening(first(&name), true);
        assert_eq!(outcome(&name, ENOUGH), "forwarded");
    }
}
