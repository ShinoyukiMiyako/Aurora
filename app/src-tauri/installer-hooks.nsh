; Tauri NSIS 模板的钩子。模板在定义各种常量之前就 include 本文件，但宏体到 !insertmacro 时才展开，
; 所以宏里能用模板后面才定义的 ${PRODUCTNAME}、$UpdateMode、$DeleteAppDataCheckboxState。

; 静默安装时 File 打不开目标的默认动作是跳过：接着写注册表和快捷方式，退出码仍是 0，装坏了看不出来。
; 这是编译期开关，对其后所有 File 生效，打不开就在写注册表之前以退出码 2 结束。
AllowSkipFiles off

; 模板的删除数据复选框只清 WebView2 档案和注册表，账户凭据和配置都留在原地。
; 便携模式下数据根就是安装目录，这里面可能有用户自己的东西，所以只按名删启动器写的文件和目录，
; 绝不递归删根目录。游戏目录 .minecraft 不在名单里，用户的存档和模组留着。
; 没有 config.json 说明这里不是落樱的数据根，同名的 logs、cache 不是我们的，一个都不碰。
!macro PETALFALL_DELETE_DATA ROOT
  ${If} ${FileExists} "${ROOT}\config.json"
    Delete "${ROOT}\config.json"
    Delete "${ROOT}\config.json.broken-*"
    Delete "${ROOT}\credentials.bin"
    Delete "${ROOT}\credentials.bin.broken-*"
    Delete "${ROOT}\offline_accounts.json"
    Delete "${ROOT}\tasks.json"
    Delete "${ROOT}\playtime.json"
    Delete "${ROOT}\java-probe-cache.json"
    ; 原子写和可写探针在进程崩溃时留下的文件
    Delete "${ROOT}\.*.tmp"
    Delete "${ROOT}\.petalfall-write-probe"
    RMDir /r "${ROOT}\logs"
    RMDir /r "${ROOT}\cache"
    RMDir /r "${ROOT}\runtime"
    RMDir /r "${ROOT}\authlib-injector"
    RMDir /r "${ROOT}\templates"
    RMDir "${ROOT}"
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ; 更新也走卸载段，那时数据要留着。静默卸载时复选框状态为空，同样不进这里。
  ${If} $DeleteAppDataCheckboxState = 1
  ${AndIf} $UpdateMode <> 1
    ; 探针失败的机器上数据在 %LOCALAPPDATA%，和安装目录是两个根
    !insertmacro PETALFALL_DELETE_DATA "$INSTDIR"
    !insertmacro PETALFALL_DELETE_DATA "$LOCALAPPDATA\${PRODUCTNAME}"
  ${EndIf}
!macroend
