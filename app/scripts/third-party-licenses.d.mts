export interface ThirdPartyPackage {
  ecosystem: "npm" | "cargo";
  name: string;
  version: string;
  /** 包里声明的许可证原文（通常是 SPDX 表达式）。 */
  license: string;
}

export interface ThirdPartyManifest {
  /** 先前端后 Rust，各自按名称、版本排序。 */
  packages: ThirdPartyPackage[];
}

export function npmLicense(pkg: { name?: string; version?: string; license?: unknown; licenses?: unknown }): string;

export function collectNpmPackages(appDir: string): ThirdPartyPackage[];

export function collectCargoPackages(metadata: unknown, rootPackage: string): ThirdPartyPackage[];

export function hostTarget(): string;

export function readCargoMetadata(manifestPath: string, target: string): unknown;

export function thirdPartyManifest(options: { appDir: string; cargoManifest: string; rootPackage: string }): ThirdPartyManifest;
