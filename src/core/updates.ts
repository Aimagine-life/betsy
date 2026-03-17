interface ReleaseInfo {
  version: string;
  changelog: string;
}

/**
 * Compare two semver strings.
 * Returns true if `latest` is newer than `current`.
 */
function isNewer(current: string, latest: string): boolean {
  const parse = (v: string) =>
    v
      .replace(/^v/, "")
      .split(".")
      .map(Number);

  const cur = parse(current);
  const lat = parse(latest);

  for (let i = 0; i < 3; i++) {
    const c = cur[i] ?? 0;
    const l = lat[i] ?? 0;
    if (l > c) return true;
    if (l < c) return false;
  }
  return false;
}

export async function checkForUpdates(
  currentVersion: string,
): Promise<ReleaseInfo | null> {
  const url =
    "https://api.github.com/repos/Aimagine-life/betsy/releases/latest";

  let data: { tag_name: string; body?: string };
  try {
    const res = await fetch(url, {
      headers: { Accept: "application/vnd.github.v3+json" },
    });
    if (!res.ok) return null;
    data = (await res.json()) as { tag_name: string; body?: string };
  } catch {
    return null;
  }

  const latestTag = data.tag_name ?? "";
  if (!latestTag) return null;

  if (!isNewer(currentVersion, latestTag)) return null;

  return {
    version: latestTag.replace(/^v/, ""),
    changelog: data.body ?? "",
  };
}
