// 实例：扫描已安装版本、版本清单、安装新版本（可带加载器）。

import { invoke } from "./bridge";

export type LoaderChoice = "fabric" | "quilt" | "forge" | "neoforge";

export interface LoaderDto {
  kind: string;
  version: string | null;
}

export interface InstalledVersionDto {
  id: string;
  mc_version: string;
  is_release: boolean;
  has_mod_loader: boolean;
  loaders: LoaderDto[];
}

export interface BrokenVersionDto {
  id: string;
  reason: string;
}

export interface VersionScanDto {
  versions: InstalledVersionDto[];
  broken: BrokenVersionDto[];
}

export interface ManifestVersionDto {
  id: string;
  /** release / snapshot / old_beta / old_alpha。 */
  release_type: string;
  url: string;
  time: string;
  release_time: string;
  sha1: string | null;
  compliance_level: number | null;
}

export interface ManifestDto {
  latest: { release: string; snapshot: string };
  versions: ManifestVersionDto[];
}

export interface InstallOutcomeDto {
  vanilla: { id: string; libraries: number; assets: number; natives: number };
  loader: { id: string; loader_version: string; libraries: number } | null;
}

export const listInstalled = (): Promise<VersionScanDto> => invoke<VersionScanDto>("list_installed");

export const listManifest = (): Promise<ManifestDto> => invoke<ManifestDto>("list_manifest");

/** 原版安装时 loader 与 loaderVersion 都传 null。 */
export const installVersion = (id: string, loader: LoaderChoice | null, loaderVersion: string | null): Promise<InstallOutcomeDto> =>
  invoke<InstallOutcomeDto>("install_version", { id, loader, loaderVersion });
