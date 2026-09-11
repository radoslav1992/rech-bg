// workerd accepts only "follow" or "manual". Reject redirects explicitly so
// credentials and paid POST requests never get forwarded to another endpoint.
export async function videoFetch(url: string, init: RequestInit = {}) {
  const response = await fetch(url, { ...init, redirect: "manual" });
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel();
    throw new Error("Video service redirect rejected");
  }
  return response;
}
