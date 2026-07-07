// Version + git sha are injected at build via `bun build --define` (see
// scripts/build-binaries.sh) and tsup; both default to "dev" for local runs.
export const VERSION = process.env.UNICLIP_VERSION ?? "dev";
export const GIT_SHA = process.env.UNICLIP_GIT_SHA ?? "dev";

export function fmtVersion(version: string, sha: string): string {
  return version !== "dev" && sha && sha !== "dev" ? `${version} (${sha})` : version;
}

export const versionString = (): string => fmtVersion(VERSION, GIT_SHA);
