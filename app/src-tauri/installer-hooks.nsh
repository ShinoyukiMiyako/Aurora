; Tauri NSIS 模板的钩子。模板在定义各种常量之前就 include 本文件，但宏体到 !insertmacro 时才展开，
; 所以宏里能用模板后面才定义的 ${PRODUCTNAME}、$UpdateMode、$DeleteAppDataCheckboxState。

; 静默安装时 File 打不开目标的默认动作是跳过：接着写注册表和快捷方式，退出码仍是 0，装坏了看不出来。
; 这是编译期开关，对其后所有 File 生效，打不开就在写注册表之前以退出码 2 结束。
AllowSkipFiles off

; 模板把上次安装目录记在 Software\<发布者>\<产品名> 的默认值里，.onInit 靠它还原目录。
; dev.10 及更早的包没设发布者，模板取 identifier 的第二段，这些包已经发出去，老键永远是这个值。
; 新键必须等于模板的 MANUPRODUCTKEY，但模板在本文件之后才定义它，只能抄一份，由安装后钩子在编译期核对。
!define PETALFALL_LEGACY_DIR_KEY "Software\petalfall\Petalfall"
!define PETALFALL_DIR_KEY "Software\Shinoyuki_Miyako\Petalfall"

; 下面的函数体就在这里编译，不像宏那样延到 !insertmacro，不能指望模板的 include 顺序
!include LogicLib.nsh

; 老安装第一次被新包交互或被动安装时，.onInit 读不到新键，$INSTDIR 停在默认目录，会在 %LOCALAPPDATA% 下另装一份。
; 界面出来之前把老键的目录抄进新键：重装页选先卸载时，模板从新键取目录交给卸载程序的 _?=，空着就卸不掉老的。
; 静默安装不调 .onGUIInit：更新器由安装前钩子纠正，引导器总带 /D=。
; 这里用不了模板常量，默认目录只能写死产品名，安装后钩子核对 MANUPRODUCTKEY 时连产品名一起兜住。
!define MUI_CUSTOMFUNCTION_GUIINIT PetalfallRestoreLegacyDir
Function PetalfallRestoreLegacyDir
  Push $0
  Push $1
  ReadRegStr $0 HKCU "${PETALFALL_DIR_KEY}" ""
  ReadRegStr $1 HKCU "${PETALFALL_LEGACY_DIR_KEY}" ""
  ${If} $0 == ""
  ${AndIf} $1 != ""
    WriteRegStr HKCU "${PETALFALL_DIR_KEY}" "" $1
    ; 不是默认目录说明命令行带了 /D=，照用户给的装
    ${If} $INSTDIR == "$LOCALAPPDATA\Petalfall"
      StrCpy $INSTDIR $1
    ${EndIf}
  ${EndIf}
  Pop $1
  Pop $0
FunctionEnd

; 更新器启动安装包从不带 /D=，老安装的目录只在老键里，.onInit 读不到就落回默认目录，
; 新版装到别处，原来那份和指向它的快捷方式都还是旧版。静默更新不走 .onGUIInit，只能在这里纠正。
; 卸载项的键只按产品名拼，改发布者不受影响，按它记的 InstallLocation 找回目录。
; 只纠正模板自己推出来的两种目录，命令行显式给的 /D= 照用；引导器从不带 /UPDATE，它的 /S /D= 不经过这里。
!macro NSIS_HOOK_PREINSTALL
  ; 上面直接读写 HKCU，这里的 SHCTX 也只在当前用户安装时才是 HKCU
  !if "${INSTALLMODE}" != "currentUser"
    !error "安装钩子按 currentUser 安装模式写成，当前是 ${INSTALLMODE}"
  !endif
  ${If} $UpdateMode = 1
    Push $0
    Push $1
    ReadRegStr $0 SHCTX "${UNINSTKEY}" "InstallLocation"
    ; 模板写入时两头加了引号
    StrCpy $1 $0 1
    ${If} $1 == '"'
      StrCpy $0 $0 -1 1
    ${EndIf}
    ReadRegStr $1 SHCTX "${MANUPRODUCTKEY}" ""
    ${If} $INSTDIR == "$LOCALAPPDATA\${PRODUCTNAME}"
    ${OrIf} $INSTDIR == $1
      ${If} $0 != ""
      ${AndIf} $0 != $INSTDIR
      ${AndIf} ${FileExists} "$0\${MAINBINARYNAME}.exe"
        StrCpy $1 $INSTDIR
        StrCpy $INSTDIR $0
        ; File 往 $OUTDIR 里放，光改 $INSTDIR 不够；当前目录也删不掉，得先切走
        SetOutPath $INSTDIR
        ; 模板的 SetOutPath 刚建出这个目录，不带 /r，里面有东西就留着
        RMDir "$1"
      ${EndIf}
    ${EndIf}
    Pop $1
    Pop $0
  ${EndIf}
!macroend

; 走到这里模板已把目录写进新键。老键留着的话卸载只清新键，老键永远删不掉，
; 引导器在新键缺失时还会退回去读它，拿到早已不用的目录。
!macro NSIS_HOOK_POSTINSTALL
  !if "${MANUPRODUCTKEY}" != "${PETALFALL_DIR_KEY}"
    !error "模板的目录键 ${MANUPRODUCTKEY} 和 PETALFALL_DIR_KEY 对不上，改发布者或产品名要同步"
  !endif
  ; 两个键一旦相同，下面删老键就是删模板刚写的目录
  !if "${MANUPRODUCTKEY}" == "${PETALFALL_LEGACY_DIR_KEY}"
    !error "模板的目录键就是老键 ${PETALFALL_LEGACY_DIR_KEY}"
  !endif
  DeleteRegKey HKCU "${PETALFALL_LEGACY_DIR_KEY}"
  ; 老发布者的键下还有别的东西就留着
  DeleteRegKey /ifempty HKCU "Software\petalfall"
!macroend

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
    Delete "${ROOT}\window-state.json"
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
