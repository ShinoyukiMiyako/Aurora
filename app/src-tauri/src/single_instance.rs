//! 一个数据目录只跑一个启动器：再次启动时把已有窗口叫到前台，新进程直接退出。
//!
//! 实例锁、任务队列、游戏会话都只在进程内互斥，两个进程共用一份数据时谁也看不见谁：同一个实例能同时装两遍、
//! 启动两遍，`config.json` 按谁后写为准。所以按数据目录占位，而不是按应用标识：两份便携版的数据互不相干，
//! 可以各开各的。
//!
//! 占位与唤醒是同一个具名事件：由系统保证只有一个进程创建成功，进程退出（包括崩溃）后系统回收，
//! 下一次启动不会被残留挡住。后来者对它 `SetEvent`，先来者的监听线程醒来把窗口叫到前台。事件自动复位，
//! 先来者还没开始监听时的那次唤醒留到开始监听时生效。

use std::path::Path;

use petalfall_base::brand::APP_NAME_EN;
use windows::Win32::Foundation::{
    CloseHandle, GetLastError, ERROR_ALREADY_EXISTS, HANDLE, WAIT_EVENT, WAIT_OBJECT_0,
};
use windows::Win32::System::Threading::{CreateEventW, SetEvent, WaitForSingleObject, INFINITE};
use windows_core::{HSTRING, PCWSTR};

/// 这次启动在数据目录上的结果。
pub enum Claim {
    /// 这个数据目录上只有这一个启动器。
    First(Instance),
    /// 已有启动器在跑，已经叫它把窗口拿到前台，这个进程该退出了。
    Forwarded,
}

/// 占着数据目录的事件。监听线程持有它活到进程退出。
pub struct Instance {
    event: HANDLE,
}

// SAFETY: 事件句柄是进程级的内核对象句柄，不绑定创建它的线程。
unsafe impl Send for Instance {}

impl Instance {
    /// 在独立线程上等后来者，每来一次调用一次 `on_request`。
    pub fn listen(self, on_request: impl Fn() + Send + 'static) -> std::io::Result<()> {
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
                on_request();
            })?;
        Ok(())
    }

    fn wait(&self) -> WAIT_EVENT {
        // SAFETY: event 是本结构持有的有效句柄，线程结束前不会关闭
        unsafe { WaitForSingleObject(self.event, INFINITE) }
    }
}

impl Drop for Instance {
    fn drop(&mut self) {
        // SAFETY: event 由 CreateEventW 创建、只在这里关闭一次
        if let Err(err) = unsafe { CloseHandle(self.event) } {
            tracing::warn!(error = %err, "关闭单实例事件句柄失败");
        }
    }
}

/// 按当前数据目录占位。
pub fn claim() -> Result<Claim, Box<dyn std::error::Error>> {
    let dir = petalfall_base::fs::data_dir()?;
    Ok(claim_name(&event_name(&dir))?)
}

/// 事件名。名字里不能有反斜杠（它是命名空间分隔符）；Windows 路径不分大小写，同一个目录换种写法也要落到同一个名字上。
/// 用 `Local` 命名空间：别的登录会话是另一个用户，数据目录本来就是他自己的。
fn event_name(data_dir: &Path) -> String {
    let dir = data_dir.to_string_lossy().replace('\\', "/").to_lowercase();
    format!(r"Local\{APP_NAME_EN}-{dir}")
}

fn claim_name(name: &str) -> windows_core::Result<Claim> {
    let name = HSTRING::from(name);
    // SAFETY: name 在调用期间有效；不带安全描述符，由系统给默认的
    let event = unsafe { CreateEventW(None, false, false, PCWSTR(name.as_ptr())) }?;
    // 句柄归结构体管，后来者走到函数末尾就关掉，不占着先来者的事件
    let instance = Instance { event };
    // SAFETY: 读当前线程的错误码。CreateEventW 成功时也用它区分「新建」与「已存在」
    if unsafe { GetLastError() } != ERROR_ALREADY_EXISTS {
        return Ok(Claim::First(instance));
    }
    // SAFETY: event 是上面拿到的有效句柄
    unsafe { SetEvent(instance.event) }?;
    Ok(Claim::Forwarded)
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;
    use std::sync::mpsc;
    use std::time::Duration;

    use super::*;

    /// 进程内的用例共用一个内核命名空间，名字带上进程号与用例名，并行跑、重复跑都不串。
    fn unique(test: &str) -> String {
        format!(r"Local\petalfall-test-{}-{test}", std::process::id())
    }

    fn first(name: &str) -> Instance {
        match claim_name(name).unwrap() {
            Claim::First(instance) => instance,
            Claim::Forwarded => panic!("{name} 上不该已有启动器"),
        }
    }

    fn is_forwarded(name: &str) -> bool {
        matches!(claim_name(name).unwrap(), Claim::Forwarded)
    }

    fn listening(instance: Instance) -> mpsc::Receiver<()> {
        let (tx, rx) = mpsc::channel();
        instance
            .listen(move || tx.send(()).unwrap())
            .expect("起监听线程");
        rx
    }

    #[test]
    fn a_later_start_on_the_same_data_dir_is_forwarded() {
        let name = unique("same");
        let _first = first(&name);
        assert!(is_forwarded(&name));
        assert!(is_forwarded(&name), "第三次启动同样转交");
    }

    #[test]
    fn each_forwarded_start_wakes_the_listener_once() {
        let name = unique("wake");
        let woken = listening(first(&name));
        for _ in 0..3 {
            assert!(is_forwarded(&name));
            woken
                .recv_timeout(Duration::from_secs(5))
                .expect("后来者要唤醒先来者");
        }
        assert!(
            woken.recv_timeout(Duration::from_millis(200)).is_err(),
            "事件自动复位，三次启动只醒三次"
        );
    }

    /// 窗口还没建好时就有人双击第二下：唤醒留在事件上，开始监听时才生效，不能丢。
    #[test]
    fn a_start_before_listening_is_not_lost() {
        let name = unique("early");
        let instance = first(&name);
        assert!(is_forwarded(&name));
        listening(instance)
            .recv_timeout(Duration::from_secs(5))
            .expect("开始监听时要收到之前的那次唤醒");
    }

    #[test]
    fn other_data_dirs_are_left_alone() {
        let a = unique("dir-a");
        let b = unique("dir-b");
        let _first = first(&a);
        assert!(!is_forwarded(&b), "别的数据目录不受影响");
    }

    /// 进程退出（包括崩溃）时系统关掉句柄，这里用 drop 代替：占位跟着进程走，不留残留挡住下次启动。
    #[test]
    fn the_claim_ends_with_the_owner() {
        let name = unique("exit");
        drop(first(&name));
        let _again = first(&name);
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

    /// 真正创建一次，确认这种名字系统收：中文路径与空格都常见。
    #[test]
    fn real_data_dir_names_are_accepted_by_the_system() {
        let dir = format!(r"D:\游戏 目录\{}\Petalfall", std::process::id());
        let name = event_name(&PathBuf::from(dir));
        let _first = first(&name);
        assert!(is_forwarded(&name));
    }
}
