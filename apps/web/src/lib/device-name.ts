// A friendly "<Browser> · <OS>" label from the UA, for the default device name.
// Order matters: Edge/Chrome both contain "Chrome"; iOS contains "like Mac OS X".
export function defaultDeviceName(): string {
  const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
  const browser =
    /Edg\//.test(ua) ? "Edge"
    : /OPR\//.test(ua) ? "Opera"
    : /Firefox\//.test(ua) ? "Firefox"
    : /Chrome\//.test(ua) ? "Chrome"
    : /Version\/.*Safari/.test(ua) ? "Safari"
    : "";
  const os =
    /iPhone/.test(ua) ? "iPhone"
    : /iPad/.test(ua) ? "iPad"
    : /Android/.test(ua) ? "Android"
    : /Macintosh|Mac OS X/.test(ua) ? "macOS"
    : /Windows/.test(ua) ? "Windows"
    : /Linux/.test(ua) ? "Linux"
    : "";
  if (browser && os) return `${browser} · ${os}`;
  return "This device";
}
