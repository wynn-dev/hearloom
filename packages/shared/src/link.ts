/** A "Link device" code and, if what was pasted or scanned says so, the server it is for. */
export interface LinkInput {
  /** http(s) origin (plus any path prefix) of the server, without a trailing slash; null for a bare code. */
  server: string | null;
  /** As given; the server reads it in any case, with or without dashes. */
  code: string;
}

const BARE_CODE = /^[0-9A-Za-z]{12}$/;

function httpBase(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return `${url.origin}${url.pathname}`.replace(/\/+$/, "");
  } catch {
    return null;
  }
}

/**
 * What someone scanned or pasted to link a device: the app's `hearloom://link?server=…&code=…`, a
 * browser's `https://<server>/link#code=…`, or just the code (XXXX-XXXX-XXXX). Null if it's none of
 * these.
 */
export function parseLinkInput(input: string): LinkInput | null {
  const text = input.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    let url: URL;
    try {
      url = new URL(text);
    } catch {
      return null;
    }
    if (url.protocol === "http:" || url.protocol === "https:") {
      if (!/\/link\/?$/.test(url.pathname)) return null;
      const code =
        new URLSearchParams(url.hash.slice(1)).get("code") ?? url.searchParams.get("code");
      const server = httpBase(`${url.origin}${url.pathname.replace(/\/link\/?$/, "")}`);
      return code && server ? { server, code } : null;
    }
    // hearloom://link?server=…&code=… (any app scheme: self-hosters may use their own).
    if (url.host !== "link" && url.pathname.replace(/^\/+/, "") !== "link") return null;
    const server = httpBase(url.searchParams.get("server"));
    const code = url.searchParams.get("code");
    return code && server ? { server, code } : null;
  }
  const bare = text.replace(/[\s-]/g, "");
  return BARE_CODE.test(bare) ? { server: null, code: text } : null;
}
