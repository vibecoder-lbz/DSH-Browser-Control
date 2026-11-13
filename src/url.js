const sensitiveKey = /token|password|passwd|secret|authorization|credential|^code$/iu;

/** Connection URLs may contain JumpServer session tokens; keep them out of model-visible metadata. */
export function publicUrl(value) {
  try {
    const url = new URL(value);
    if (url.username) url.username = 'redacted';
    if (url.password) url.password = 'redacted';
    for (const key of [...url.searchParams.keys()]) {
      if (sensitiveKey.test(key)) url.searchParams.set(key, '[redacted]');
    }
    url.pathname = url.pathname.replace(/(\/token\/)[^/]+/giu, '$1[redacted]');
    url.hash = url.hash.replace(/(\/token\/)[^/?#]+/giu, '$1[redacted]');
    return url.href;
  } catch { return String(value).slice(0, 2000); }
}
