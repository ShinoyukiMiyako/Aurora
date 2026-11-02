//! 处理器进程树的归属。
//!
//! 取消时只结束 java 本身的话，它起的子进程还活着：继续往共享的库目录写产物，还占着输出管道。Windows 上把
//! 处理器放进「句柄关闭即结束全部进程」的 Job 对象，这个守卫一丢弃，整棵树就没了；安装的 future 被整个丢弃
//! 时同样如此。别的系统上处理器在 `kill_on_drop` 之外没有额外保证。

use tokio::process::Child;

#[cfg(windows)]
pub(crate) struct ProcessTree(windows_sys::Win32::Foundation::HANDLE);

// Job 句柄是内核对象句柄，不绑线程。
#[cfg(windows)]
unsafe impl Send for ProcessTree {}

#[cfg(windows)]
impl ProcessTree {
    /// 接管 `child`。子进程已经退出时没什么可管，返回一个空的 Job。
    pub(crate) fn adopt(child: &Child) -> std::io::Result<Self> {
        use std::io::Error;
        use std::ptr::null;
        use windows_sys::Win32::Foundation::HANDLE;
        use windows_sys::Win32::System::JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
            SetInformationJobObject,
        };

        // SAFETY: 两个指针参数都允许为空：默认安全属性，不命名。
        let job = unsafe { CreateJobObjectW(null(), null()) };
        if job.is_null() {
            return Err(Error::last_os_error());
        }
        // 句柄归守卫所有，下面失败时由 Drop 关掉。
        let tree = Self(job);

        // SAFETY: 全零是这个结构的合法取值：只有整数字段。
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        // SAFETY: job 有效；指针与长度都来自上面这个活着的结构。
        let configured = unsafe {
            SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                (&raw const limits).cast(),
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        };
        if configured == 0 {
            return Err(Error::last_os_error());
        }

        let Some(process) = child.raw_handle() else {
            return Ok(tree);
        };
        // SAFETY: job 有效；process 由 child 持有，借用期间不会关闭。
        let assigned = unsafe { AssignProcessToJobObject(job, process as HANDLE) };
        if assigned == 0 {
            return Err(Error::last_os_error());
        }
        Ok(tree)
    }
}

#[cfg(windows)]
impl Drop for ProcessTree {
    fn drop(&mut self) {
        // SAFETY: 句柄是 adopt 里拿到的，只在这里关一次。关闭失败时无事可做，进程随启动器退出。
        unsafe { windows_sys::Win32::Foundation::CloseHandle(self.0) };
    }
}

#[cfg(not(windows))]
pub(crate) struct ProcessTree;

#[cfg(not(windows))]
impl ProcessTree {
    pub(crate) fn adopt(_child: &Child) -> std::io::Result<Self> {
        Ok(Self)
    }
}
