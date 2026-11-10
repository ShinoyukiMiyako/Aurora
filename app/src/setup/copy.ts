// 引导程序的全部界面文案。启动器的文案表带着状态层的依赖进不来，这里单独一份。
// 语言跟随系统：zh 开头走中文，其余一律英文，不提供切换。ZH、EN 两张表都标注 SetupCopy，缺键由 tsc 报错。

import { APP_LICENSE, APP_NAME, APP_NAME_EN, ASSET_LICENSE, COPYRIGHT_HOLDER, FIRST_RELEASE_YEAR } from "../lib/app-info";
import type { Channel, DataBlock, DirIssue, FailureCode, InstallMode, NewerReason, Phase } from "./contract";
import type { FailureRecovery } from "./model";

export type Lang = "zh" | "en";

/** 系统语言到界面语言。空串说明环境坏了，抛错而不是落到某个语言上。 */
export function pickLang(language: string): Lang {
  if (language === "") throw new Error("系统语言是空串");
  return /^zh(?:[-_]|$)/i.test(language) ? "zh" : "en";
}

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

/** 选目录页的空间提示：只到 GB。到不了 1 MB 的量这里用不上。 */
export function formatBytes(bytes: number): string {
  if (bytes >= GIB) return `${(bytes / GIB).toFixed(1)} GB`;
  return `${Math.ceil(bytes / MIB)} MB`;
}

export interface FailureText {
  title: string;
  /** detail 是 Failure.detail：payload_exit 时是退出码。recovery 是这一页给的退路，话要和按钮对得上。 */
  body(detail: string, recovery: FailureRecovery): string;
}

export interface InstalledText {
  /** installed 是现有安装的版本。 */
  title(installed: string): string;
  /** payload 是这个安装包的版本。 */
  lead(installed: string, payload: string): string;
}

/** 两边的通道都要说出来的说明：ci、cp 是已装的与这个安装包的通道名，installed、payload 是两边的版本。 */
export type CrossLead = (ci: string, installed: string, cp: string, payload: string) => string;

/** newer 的说明按后端给的原因挑：跨通道的两种要写出两边的通道，同通道与认不出通道的只写版本。 */
export type NewerLeads = { readonly [R in NewerReason]: R extends "faster_channel" | "slower_channel" ? CrossLead : (installed: string, payload: string) => string };

/**
 * 安装中、完成页按模式的标题。switch 是「换到」的说法，channel 是换到的通道名：换通道安装、以及在「换到」页上确认的升级都用它，
 * 由 modeTitle 按这次是不是换通道来挑。
 */
export type ModeTitles = { readonly [M in InstallMode]: M extends "switch" ? (channel: string, version: string) => string : (version: string) => string };

export interface SetupCopy {
  /** 通道名另放一份，不用启动器的那张表：那张只有中文，还被 Mod 的版本档标签引用着。 */
  channel: Readonly<Record<Channel, string>>;
  frame: {
    minimize: string;
    close: string;
    closeBlocked: string;
    /** 左栏底部一行：版本和协议。 */
    versionLine(version: string): string;
    /** 探测之前就崩溃时没有版本，只写协议。 */
    license: string;
    legalLink: string;
  };
  welcome: {
    title: string;
    lead: string;
    /** 启动器界面还只有中文，英文系统的用户要先知道。中文表里为 null。 */
    languageNote: string | null;
    interrupted: string;
    locationLabel: string;
    change: string;
    legalNote: string;
    install: string;
  };
  location: {
    title: string;
    lead: string;
    inputLabel: string;
    browse: string;
    shortcut: string;
    useDefault: string;
    back: string;
    installHere: string;
    issue: Readonly<Record<Exclude<DirIssue, "data_incompatible">, string>>;
    /** 被数据关拦下：说法看目录校验带回的拦截详情，用过这份数据的版本写得出来就写。 */
    dataIncompatible: {
      named(channel: string, writtenBy: string): string;
      unnamed: string;
      unreadable: string;
    };
    resume: string;
    /** 目录里有别的文件、在里面另建了一层：说清楚会新建文件夹，实际路径由 finalPath 另起一行。 */
    nested: string;
    notEmpty: string;
    /** 另建了一层时，用户要看到实际落在哪。 */
    finalPath(path: string): string;
    space(needed: string, free: string): string;
  };
  blocked: {
    title: string;
    lead: string;
    checkAgain: string;
    back: string;
  };
  installing: {
    title: ModeTitles;
    phase: Readonly<Record<Phase, string>>;
    slow: string;
    progressLabel: string;
  };
  done: {
    title: ModeTitles;
    firstRun: string;
    kept: string;
    elevated: string;
    open: string;
    close: string;
  };
  failed: {
    reason: Readonly<Record<FailureCode, FailureText>>;
    /**
     * 在原因说明末尾补一句怎么回到原来的通道：启动器带换通道开关拉起的那次装失败时，更新通道已经改成了目标通道。
     * 文案冻结在每个安装包里，只指向启动器设置里一直都在的那个入口。
     */
    channelRevert(body: string): string;
    retry: string;
    changeLocation: string;
    openLog: string;
    report: string;
    standardInstaller: string;
    back: string;
  };
  installed: {
    kind: {
      /** lead 是同通道或认不出通道的升级。 */
      upgrade: InstalledText & {
        /** 升到另一个通道上更新的版本、不换通道：之后照设置里选的更新通道检查更新，标题同 upgrade。 */
        cross(cp: string, payload: string): string;
        /** 升级时换到更快的通道，确认后落樱按 cp 检查更新；标题与按钮同 switch。 */
        switching: CrossLead;
      };
      same: InstalledText;
      newer: { title(installed: string): string; lead: NewerLeads };
      broken: InstalledText;
      /** 已装的更新，安装包是更慢通道上更早的版本：确认后换过去。 */
      switch: { title(cp: string): string; lead: CrossLead };
    };
    /** 数据被更新的落樱用过，这个安装包读不了。 */
    dataTooNew: {
      title: string;
      /** 用过这份数据的版本写得出来时：channel 是它的通道名。 */
      named(channel: string, writtenBy: string, payload: string): string;
      unnamed(payload: string): string;
    };
    /** 数据格式记录读不懂。path 是那个记号文件，页面把这段说明做成可选中的文字，反馈时好复制。 */
    dataUnreadable: {
      title: string;
      lead(path: string, reason: string): string;
    };
    /** 更新模式下停在什么都装不了的那几页时，在说明末尾补一句：落樱是为这次更新关掉的，可以从这里重新打开。 */
    closedForUpdate(lead: string): string;
    locationLabel: string;
    update: string;
    /** 「换到」页的主按钮。 */
    switchTo(cp: string): string;
    reinstall: string;
    open: string;
    legalNote: string;
  };
  legal: {
    title: string;
    freeSoftware: string;
    /** 三份原文之间切换的标签组的名字。 */
    documents: string;
    licenseHeading: string;
    englishOnly: string;
    licenseFailed: string;
    termsHeading: string;
    termsFailed: string;
    assetsHeading: string;
    assetsFailed: string;
    /** 附加条款与素材许可两份原文的语言说明。 */
    chinesePrevails: string;
    sourceLink: string;
    thirdPartyHeading: string;
    thirdPartyLoading: string;
    thirdPartyFailed: string;
    /** 附加条款第 2 节要求在适当法律声明里显示的版权行，与启动器关于页同一行。 */
    copyright: string;
    assets: string;
    trademark: string;
    back: string;
  };
  fatal: {
    title: string;
    lead: string;
    close: string;
  };
}

/** 欢迎页标题下的说明：英文界面在后面补上语言说明。选目录页也要它，按它给说明区占高。 */
export function welcomeLead(copy: SetupCopy): string {
  const { lead, languageNote } = copy.welcome;
  return languageNote === null ? lead : `${lead} ${languageNote}`;
}

/** 安装中、完成页的标题：这次是换到某个通道（model 的 switchingTo 给出）时说「换到」，否则按模式说。 */
export function modeTitle(copy: SetupCopy, titles: ModeTitles, mode: InstallMode, switching: Channel | null, version: string): string {
  if (switching !== null) return titles.switch(copy.channel[switching], version);
  if (mode === "switch") throw new Error("换通道安装却没给出换到的通道");
  return titles[mode](version);
}

/**
 * 用过这份数据的那一版：后端只在版本号形状合格时给，连同它的通道一起；没给时说明改用笼统的说法。
 * 给了版本却没给通道是契约坏了，不拿通道名去猜。
 */
export function dataWriter(block: DataBlock): { channel: Channel; version: string } | null {
  if (block.writtenBy === null) return null;
  if (block.writtenByChannel === null) throw new Error(`拦截详情给了用过数据的版本 ${block.writtenBy}，却没给它的通道`);
  return { channel: block.writtenByChannel, version: block.writtenBy };
}

// 只说代码按 AGPL 开源：美术素材另按素材许可授权，说成整个程序都按 AGPL 就成了对素材的默示许可
const LEGAL_NOTE_ZH = `${APP_NAME}的代码按 ${APP_LICENSE} 及其附加条款开源，美术素材按 ${ASSET_LICENSE} 授权，不提供任何担保，你可以按协议转发。`;
const LEGAL_NOTE_EN = `${APP_NAME_EN}'s code is open source under ${APP_LICENSE} with additional terms, and its art assets are licensed under ${ASSET_LICENSE}. It comes with no warranty. You may redistribute it under those licenses.`;
const DATA_UNTOUCHED_ZH = "设置、账户和游戏文件都不动。";
const DATA_UNTOUCHED_EN = "Your settings, accounts and game files stay as they are.";
/** 覆盖安装换位置等于搬数据目录，这时不能叫人换文件夹。 */
const LOCKED_LOCATION_ZH = "现有的安装位置不能换。";
const LOCKED_LOCATION_EN = "The existing install can't move.";

const ZH: SetupCopy = {
  channel: { dev: "预览版", beta: "测试版", stable: "正式版" },
  frame: {
    minimize: "最小化",
    close: "关闭",
    closeBlocked: "安装中不能关闭",
    versionLine: (version) => `版本 ${version} · ${APP_LICENSE}`,
    license: APP_LICENSE,
    legalLink: "协议与源代码",
  },
  welcome: {
    title: `把${APP_NAME}装到这台电脑`,
    lead: "下载、管理并启动 Minecraft: Java 版，Mod、存档和账户都在一处。",
    languageNote: null,
    interrupted: "上次的安装没有完成，可以在这里接着装。",
    locationLabel: "安装位置",
    change: "更改",
    legalNote: LEGAL_NOTE_ZH,
    install: "安装",
  },
  location: {
    title: "选一个安装位置",
    lead: "程序、设置、账户和默认的游戏目录都会放在这里。",
    inputLabel: "安装位置",
    browse: "浏览",
    shortcut: "在桌面放一个快捷方式",
    useDefault: "用回默认位置",
    back: "返回",
    installHere: "安装到这里",
    issue: {
      empty: "安装位置不能为空",
      relative: "要写完整路径，从盘符开始",
      bang: "路径里不能有「!」，Java 会读不出里面的游戏文件",
      forbidden: "这个位置不适合放程序和游戏文件，换一个文件夹",
      minecraft: `这里是游戏文件夹，不能当安装位置。装好后在${APP_NAME}里把它加为游戏目录`,
      network: "网络位置装不了，换一块本机的盘",
      unwritable: "这个位置写不进去，换一个你有权限的文件夹",
      no_space: "这块盘空间不够",
    },
    dataIncompatible: {
      named: (channel, writtenBy) => `这里的数据被更新的${APP_NAME}用过，这个安装包读不了。换一个位置，或者装${channel} ${writtenBy} 或更新的版本`,
      unnamed: `这里的数据被更新的${APP_NAME}用过，这个安装包读不了。换一个位置，或者装更新的版本`,
      unreadable: "这里的数据格式记录读不懂，换一个位置",
    },
    resume: "这里有之前留下的设置和游戏文件，装好后接着用。",
    nested: `这个文件夹里已经有别的文件，会在里面新建一个 ${APP_NAME_EN} 文件夹来装`,
    notEmpty: "这个文件夹里已经有别的文件，建议换一个空文件夹",
    finalPath: (path) => `实际会装到 ${path}`,
    space: (needed, free) => `需要约 ${needed}，这块盘还剩 ${free}`,
  },
  blocked: {
    title: `${APP_NAME}还开着`,
    lead: `继续的话它会被直接结束，正在进行的下载和没保存的改动会丢。先关掉${APP_NAME}，这里会自动继续。`,
    checkAgain: "重新检查",
    back: "返回",
  },
  installing: {
    title: {
      fresh: () => `正在安装${APP_NAME}`,
      upgrade: (version) => `正在升级到 ${version}`,
      repair: () => `正在重新安装${APP_NAME}`,
      switch: (channel, version) => `正在换到${channel} ${version}`,
    },
    phase: {
      unpack: "解开安装包",
      write: "写入文件",
      verify: "检查结果",
    },
    slow: "比平时久一些，杀毒软件扫描时会慢一点",
    progressLabel: "安装进度",
  },
  done: {
    title: {
      fresh: () => "装好了",
      upgrade: (version) => `已升级到 ${version}`,
      repair: () => "重新安装完成",
      switch: (channel, version) => `已换到${channel} ${version}`,
    },
    firstRun: `第一次打开时，${APP_NAME}会带你设置游戏目录、Java 和账户。`,
    kept: "设置、账户和游戏文件都还在。",
    elevated: `安装程序是以管理员身份运行的，从开始菜单打开${APP_NAME}才是普通权限。`,
    open: `打开${APP_NAME}`,
    close: "关闭",
  },
  failed: {
    reason: {
      dir_unwritable: { title: "这个位置写不进去", body: (_, recovery) => (recovery === "retry" ? `${LOCKED_LOCATION_ZH}确认你能写这个文件夹后再试。` : "换一个你有权限的文件夹再试。") },
      disk_full: { title: "这块盘空间不够", body: (_, recovery) => (recovery === "retry" ? `${LOCKED_LOCATION_ZH}腾出空间后再试。` : "腾出空间或换一块盘再试。") },
      extract_failed: { title: "安装包没能解开", body: () => "杀毒软件可能拦下了它。放行后重试，或者重新下载一份。" },
      payload_exit: { title: "安装没有完成", body: (detail) => `安装程序提前退出了，返回码 ${detail}。` },
      verify_failed: { title: "安装没有完成", body: () => "安装程序报告成功，但事后检查没有通过，下面是没过的项。" },
    },
    channelRevert: (body) => `${body}想留在原来的通道，到${APP_NAME}的「设置 · 关于」把更新通道改回去。`,
    retry: "重试",
    changeLocation: "换个位置",
    openLog: "打开日志",
    report: "问题反馈",
    standardInstaller: "改用标准安装程序",
    back: "返回",
  },
  installed: {
    kind: {
      upgrade: {
        title: (installed) => `发现${APP_NAME} ${installed}`,
        lead: (_, payload) => `可以升级到 ${payload}，${DATA_UNTOUCHED_ZH}`,
        cross: (cp, payload) => `可以升级到${cp} ${payload}，${DATA_UNTOUCHED_ZH}之后按${APP_NAME}设置里选的更新通道检查更新，没选过就按${cp}。`,
        switching: (ci, installed, cp, payload) => `这台电脑上是${ci} ${installed}，可以换到${cp} ${payload}。换过去以后${APP_NAME}按${cp}检查更新，${DATA_UNTOUCHED_ZH}`,
      },
      same: {
        title: (installed) => `${APP_NAME} ${installed} 已经装好了`,
        lead: () => `文件有问题时可以重新安装一遍，${DATA_UNTOUCHED_ZH}`,
      },
      newer: {
        title: () => `这台电脑上的${APP_NAME}更新`,
        lead: {
          same_channel: (installed, payload) => `已安装 ${installed}，这个安装包是 ${payload}，版本更早，不能往回装。`,
          slower_channel: (ci, installed, cp, payload) =>
            `已安装${ci} ${installed}，这个安装包是版本更早的${cp} ${payload}。自动更新不会这样换过去，所以没有安装。要换到${cp}，直接运行${cp}的安装包。`,
          faster_channel: (ci, installed, cp, payload) =>
            `已安装${ci} ${installed}，这个安装包是${cp} ${payload}，版本更早，不能这样换过去。要换到${cp}，在${APP_NAME}的「设置 · 关于」里把更新通道选成${cp}，${cp}出了比 ${installed} 新的版本就会装上。`,
          unknown_channel: (installed, payload) => `已安装 ${installed}，这个安装包是 ${payload}，不能往回装。`,
        },
      },
      broken: {
        title: () => "上次的安装不完整",
        lead: () => `重新安装可以补全缺的文件，${DATA_UNTOUCHED_ZH}`,
      },
      switch: {
        title: (cp) => `换到${cp}`,
        lead: (ci, installed, cp, payload) =>
          `这台电脑上是${ci} ${installed}，这个安装包是版本更早的${cp} ${payload}。换过去以后${APP_NAME}按${cp}检查更新。账户和游戏文件都留着；${ci}里新加的设置项，在${cp}里改过设置后可能回到默认值。`,
      },
    },
    dataTooNew: {
      title: "这个安装包读不了现在的数据",
      named: (channel, writtenBy, payload) =>
        `这台电脑上的数据已经被${channel} ${writtenBy} 用过，这个安装包（${payload}）读不了，所以没有安装，${APP_NAME}的程序和数据都没有改动。要接着用这些数据，装${channel} ${writtenBy} 或更新的版本。`,
      unnamed: (payload) => `这台电脑上的数据已经被更新的${APP_NAME}用过，这个安装包（${payload}）读不了，所以没有安装，${APP_NAME}的程序和数据都没有改动。要接着用这些数据，装更新的版本。`,
    },
    dataUnreadable: {
      title: "读不懂这台电脑上的数据格式记录",
      lead: (path, reason) => `${path}：${reason}。判断不了这里的数据能不能用这个安装包，所以没有安装，${APP_NAME}的程序和数据都没有改动。反馈问题时带上这个路径和原因。`,
    },
    closedForUpdate: (lead) => `${lead}${APP_NAME}刚才为更新关掉了，可以从这里重新打开。`,
    locationLabel: "安装位置",
    update: "升级",
    switchTo: (cp) => `换到${cp}`,
    reinstall: "重新安装",
    open: `打开${APP_NAME}`,
    legalNote: LEGAL_NOTE_ZH,
  },
  legal: {
    title: "协议与源代码",
    freeSoftware: `${APP_NAME}的程序代码是自由软件，你可以按 ${APP_LICENSE} 及其附加条款转发和修改它。它按现状提供，不提供任何担保。`,
    documents: "协议原文",
    licenseHeading: "协议全文",
    englishOnly: "协议全文只有英文版",
    licenseFailed: "协议全文读不出来",
    termsHeading: "附加条款",
    termsFailed: "附加条款读不出来",
    assetsHeading: "素材许可",
    assetsFailed: "素材许可读不出来",
    chinesePrevails: "中文为准，附英文对照",
    sourceLink: "查看源代码",
    thirdPartyHeading: "第三方许可",
    thirdPartyLoading: "正在读取许可清单…",
    thirdPartyFailed: "第三方许可清单读不出来",
    // 版权符号写成转义：它在 Unicode 里属于 Extended_Pictographic，令牌守卫的 Emoji 规则按码位判断会把它算进去
    copyright: `Copyright \u00A9 ${FIRST_RELEASE_YEAR} ${COPYRIGHT_HOLDER}`,
    assets: `应用图标、像素花瓣徽记等列在素材许可里的美术素材另按 ${ASSET_LICENSE} 授权：可以非商业地原样转发并署名，不能商用，也不能改作后发布。`,
    trademark: `Minecraft 是 Mojang Studios 的商标。${APP_NAME}是社区开源项目，与 Mojang Studios 和 Microsoft 没有关联。`,
    back: "返回",
  },
  fatal: {
    title: "安装程序没能继续",
    lead: "重新打开试试。下面是出错的原文，反馈问题时带上它。",
    close: "关闭",
  },
};

const EN: SetupCopy = {
  channel: { dev: "Preview", beta: "Beta", stable: "Stable" },
  frame: {
    minimize: "Minimize",
    close: "Close",
    closeBlocked: "Can't close while installing",
    versionLine: (version) => `Version ${version} · ${APP_LICENSE}`,
    license: APP_LICENSE,
    legalLink: "License and source",
  },
  welcome: {
    title: `Install ${APP_NAME_EN}`,
    lead: "Download, manage and launch Minecraft: Java Edition. Mods, saves and accounts all in one place.",
    languageNote: `${APP_NAME_EN}'s own interface is in Simplified Chinese for now.`,
    interrupted: "The last install didn't finish. You can pick it up here.",
    locationLabel: "Location",
    change: "Change",
    legalNote: LEGAL_NOTE_EN,
    install: "Install",
  },
  location: {
    title: "Choose a location",
    lead: "The app, settings, accounts and the default game folder all live here.",
    inputLabel: "Location",
    browse: "Browse",
    shortcut: "Add a desktop shortcut",
    useDefault: "Use default",
    back: "Back",
    installHere: "Install here",
    issue: {
      empty: "Enter a location",
      relative: "Use a full path, starting with the drive letter",
      bang: "The path can't contain \"!\". Java couldn't read the game files inside",
      forbidden: "This location isn't suitable for the app and game files. Pick another folder",
      minecraft: `This is a game folder, so it can't be the install location. Add it as a game folder in ${APP_NAME_EN} afterwards`,
      network: "Network locations aren't supported. Pick a local drive",
      unwritable: "Can't write here. Pick a folder you have access to",
      no_space: "Not enough space on this drive",
    },
    dataIncompatible: {
      named: (channel, writtenBy) => `Data here was used by a newer ${APP_NAME_EN} that this installer can't read. Pick another location, or install ${channel} ${writtenBy} or later`,
      unnamed: `Data here was used by a newer ${APP_NAME_EN} that this installer can't read. Pick another location, or install a newer version`,
      unreadable: "The data format record here can't be read. Pick another location",
    },
    resume: "This folder has settings and game files from before. They'll carry over.",
    nested: `This folder already has other files, so setup will make a ${APP_NAME_EN} folder inside it`,
    notEmpty: "This folder already has other files. An empty folder is a better choice",
    finalPath: (path) => `Will install to ${path}`,
    space: (needed, free) => `Needs about ${needed}, ${free} free on this drive`,
  },
  blocked: {
    title: `${APP_NAME_EN} is running`,
    lead: `Installing would force it to quit, and downloads in progress would be lost. Close ${APP_NAME_EN} and setup will continue on its own.`,
    checkAgain: "Check again",
    back: "Back",
  },
  installing: {
    title: {
      fresh: () => `Installing ${APP_NAME_EN}`,
      upgrade: (version) => `Updating to ${version}`,
      repair: () => `Reinstalling ${APP_NAME_EN}`,
      switch: (channel, version) => `Switching to ${channel} ${version}`,
    },
    phase: {
      unpack: "Unpacking",
      write: "Writing files",
      verify: "Checking result",
    },
    slow: "Taking longer than usual. Antivirus scans can slow this down",
    progressLabel: "Install progress",
  },
  done: {
    title: {
      fresh: () => "All set",
      upgrade: (version) => `Updated to ${version}`,
      repair: () => "Reinstalled",
      switch: (channel, version) => `Switched to ${channel} ${version}`,
    },
    firstRun: `${APP_NAME_EN} will walk you through the game folder, Java and accounts on first launch.`,
    kept: "Your settings, accounts and game files are untouched.",
    elevated: `Setup is running as administrator. Open ${APP_NAME_EN} from the Start menu so it runs with normal rights.`,
    open: `Open ${APP_NAME_EN}`,
    close: "Close",
  },
  failed: {
    reason: {
      dir_unwritable: { title: "Can't write to this location", body: (_, recovery) => (recovery === "retry" ? `${LOCKED_LOCATION_EN} Make sure you can write to this folder, then try again.` : "Pick a folder you have access to and try again.") },
      disk_full: { title: "Not enough disk space", body: (_, recovery) => (recovery === "retry" ? `${LOCKED_LOCATION_EN} Free up some space, then try again.` : "Free up some space or pick another drive, then try again.") },
      extract_failed: { title: "Couldn't unpack the installer", body: () => "Antivirus software may have blocked it. Allow it and try again, or download a fresh copy." },
      payload_exit: { title: "The install didn't finish", body: (detail) => `The installer quit early with code ${detail}.` },
      verify_failed: { title: "The install didn't finish", body: () => "The installer reported success, but the check afterwards failed. The failed items are below." },
    },
    channelRevert: (body) => `${body} To stay on your previous channel, change the update channel back in ${APP_NAME_EN}'s Settings, About.`,
    retry: "Retry",
    changeLocation: "Choose another location",
    openLog: "Open log",
    report: "Report a problem",
    standardInstaller: "Use the standard installer",
    back: "Back",
  },
  installed: {
    kind: {
      upgrade: {
        title: (installed) => `${APP_NAME_EN} ${installed} found`,
        lead: (_, payload) => `You can update to ${payload}. ${DATA_UNTOUCHED_EN}`,
        cross: (cp, payload) =>
          `You can update to ${cp} ${payload}. ${DATA_UNTOUCHED_EN} Afterwards ${APP_NAME_EN} checks for updates on the update channel chosen in its settings, or on ${cp} if none was chosen.`,
        switching: (ci, installed, cp, payload) => `${ci} ${installed} is installed. You can switch to ${cp} ${payload}, and ${APP_NAME_EN} will then check for ${cp} updates. ${DATA_UNTOUCHED_EN}`,
      },
      same: {
        title: (installed) => `${APP_NAME_EN} ${installed} is already installed`,
        lead: () => `If files are damaged you can reinstall. ${DATA_UNTOUCHED_EN}`,
      },
      newer: {
        title: () => `A newer ${APP_NAME_EN} is installed`,
        lead: {
          same_channel: (installed, payload) => `${installed} is installed and this installer is the earlier ${payload}, so it can't go back.`,
          slower_channel: (ci, installed, cp, payload) =>
            `${ci} ${installed} is installed and this installer is the earlier ${cp} ${payload}. Automatic updates don't switch channels this way, so nothing was installed. To move to ${cp}, run a ${cp} installer directly.`,
          faster_channel: (ci, installed, cp, payload) =>
            `${ci} ${installed} is installed and this installer is the earlier ${cp} ${payload}, so it can't switch this way. To move to ${cp}, choose ${cp} as the update channel in ${APP_NAME_EN}'s Settings, About; it installs once ${cp} has a version newer than ${installed}.`,
          unknown_channel: (installed, payload) => `${installed} is installed and this installer is ${payload}, so it can't go back.`,
        },
      },
      broken: {
        title: () => "The last install is incomplete",
        lead: () => `Reinstalling restores the missing files. ${DATA_UNTOUCHED_EN}`,
      },
      switch: {
        title: (cp) => `Switch to ${cp}`,
        lead: (ci, installed, cp, payload) =>
          `${ci} ${installed} is installed, and this installer has the earlier ${cp} ${payload}. After switching, ${APP_NAME_EN} checks for ${cp} updates. Your accounts and game files are kept; settings added in ${ci} may return to their defaults once you change settings in ${cp}.`,
      },
    },
    dataTooNew: {
      title: "This installer can't read your current data",
      named: (channel, writtenBy, payload) =>
        `The data on this PC has been used by ${channel} ${writtenBy}, which this installer (${payload}) can't read, so nothing was installed and ${APP_NAME_EN}'s program files and data were left unchanged. To keep using this data, install ${channel} ${writtenBy} or later.`,
      unnamed: (payload) =>
        `The data on this PC has been used by a newer ${APP_NAME_EN}, which this installer (${payload}) can't read, so nothing was installed and ${APP_NAME_EN}'s program files and data were left unchanged. To keep using this data, install a newer version.`,
    },
    dataUnreadable: {
      title: "Can't read the data format record on this PC",
      lead: (path, reason) =>
        `${path}: ${reason}. It's unclear whether this installer can use the data here, so nothing was installed and ${APP_NAME_EN}'s program files and data were left unchanged. Include this path and reason if you report the problem.`,
    },
    closedForUpdate: (lead) => `${lead} ${APP_NAME_EN} closed for the update. You can reopen it here.`,
    locationLabel: "Location",
    update: "Update",
    switchTo: (cp) => `Switch to ${cp}`,
    reinstall: "Reinstall",
    open: `Open ${APP_NAME_EN}`,
    legalNote: LEGAL_NOTE_EN,
  },
  legal: {
    title: "License and source",
    freeSoftware: `${APP_NAME_EN}'s program code is free software. You may redistribute and modify it under ${APP_LICENSE} and its additional terms. It is provided as is, with no warranty.`,
    documents: "License texts",
    licenseHeading: "Full license",
    englishOnly: "The full license is available in English only",
    licenseFailed: "Couldn't read the full license",
    termsHeading: "Additional terms",
    termsFailed: "Couldn't read the additional terms",
    assetsHeading: "Asset license",
    assetsFailed: "Couldn't read the asset license",
    chinesePrevails: "Chinese text prevails, English included",
    sourceLink: "View source code",
    thirdPartyHeading: "Third-party licenses",
    thirdPartyLoading: "Reading the license list…",
    thirdPartyFailed: "Couldn't read the third-party license list",
    // 版权符号写成转义：它在 Unicode 里属于 Extended_Pictographic，令牌守卫的 Emoji 规则按码位判断会把它算进去
    copyright: `Copyright \u00A9 ${FIRST_RELEASE_YEAR} ${COPYRIGHT_HOLDER}`,
    assets: `The app icon, the pixel petal mark and the other art assets listed in the asset license are licensed separately under ${ASSET_LICENSE}: you may share them unmodified for non-commercial purposes with attribution, but may not use them commercially or share modified versions.`,
    trademark: `Minecraft is a trademark of Mojang Studios. ${APP_NAME_EN} is a community open source project, not affiliated with Mojang Studios or Microsoft.`,
    back: "Back",
  },
  fatal: {
    title: "Setup can't continue",
    lead: "Try opening it again. The original error is below. Include it if you report the problem.",
    close: "Close",
  },
};

export const COPY: Readonly<Record<Lang, SetupCopy>> = { zh: ZH, en: EN };
