export async function fetchCodexReleaseJson(
  url,
  {
    fetchImplementation = globalThis.fetch,
    sleep = defaultSleep,
    attempts = 3,
  } = {},
) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let response;
    try {
      response = await fetchImplementation(url, {
        headers: releaseHeaders(),
      });
      if (response.ok) {
        return await response.json();
      }
    } catch (error) {
      lastError = error;
      response = undefined;
      if (attempt === attempts) {
        break;
      }
    }
    if (response) {
      lastError = new Error(`GitHub Release API 返回 HTTP ${response.status}`);
      if (!isRetryableStatus(response.status)) {
        throw lastError;
      }
    }
    if (attempt < attempts) {
      await sleep(attempt * 1_000);
    }
  }
  throw lastError ?? new Error("GitHub Release API 请求失败。");
}

function isRetryableStatus(status) {
  return status === 429 || (status >= 500 && status <= 599);
}

function releaseHeaders() {
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "codex-channels-release-check",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (process.env.GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }
  return headers;
}

function defaultSleep(milliseconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}
