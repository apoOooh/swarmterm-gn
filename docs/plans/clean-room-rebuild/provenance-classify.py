import subprocess, sys, csv, re, fnmatch, time
REPO = r"G:\ai\claude\swarmterm-gn\repo"
UP_LAST = "89f9bb780c0aa0b99cfe638235c580de2f1a1319"
UP = "duongducnguyen"
out = sys.argv[1]
limit = int(sys.argv[2]) if len(sys.argv) > 2 else 0
def git(*a):
    return subprocess.run(["git", "-C", REPO, *a], capture_output=True, text=True, encoding="utf-8", errors="replace").stdout
files = [f for f in git("ls-files", "*.rs", "*.ts", "*.tsx", "*.js", "*.css").splitlines()
         if not f.startswith(("dist/", "node_modules/"))]
up_paths = set(git("ls-tree", "-r", "--name-only", UP_LAST).splitlines())
# third-party paths from REUSE.toml (Apache annotations)
reuse = open(REPO + r"\REUSE.toml", encoding="utf-8").read()
tp = set(re.findall(r'"(src/lib/(?:agent-state|files|theme)/[^"]+)"', reuse))
if limit: files = files[:limit]
t0 = time.time()
with open(out, "w", newline="", encoding="utf-8") as fh:
    w = csv.writer(fh)
    w.writerow(["path", "lines", "upstream_lines", "upstream_pct", "at_upstream_path", "first_author", "third_party", "class"])
    for f in files:
        bl = git("blame", "--line-porcelain", "-w", "-M", "-C", "HEAD", "--", f)
        authors = [l[7:] for l in bl.splitlines() if l.startswith("author ")]
        n = len(authors); u = sum(1 for a in authors if a == UP)
        adds = git("log", "--follow", "--diff-filter=A", "--format=%an", "--", f).splitlines()
        first = adds[-1] if adds else "?"
        at_up = f in up_paths
        third = f in tp
        pct = round(100.0 * u / n, 1) if n else 0.0
        if third: cls = "c"
        elif at_up or first == UP or pct >= 20: cls = "b"
        elif u == 0: cls = "a"
        else: cls = "a?"
        w.writerow([f, n, u, pct, int(at_up), first, int(third), cls])
print(len(files), "files", round(time.time() - t0), "s")
