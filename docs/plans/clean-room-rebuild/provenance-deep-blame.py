import csv, os, subprocess, sys, time
# Repo root: SWARMTERM_REPO, else three levels above this script (docs/plans/clean-room-rebuild).
REPO = os.environ.get("SWARMTERM_REPO") or os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
rows = [r for r in csv.DictReader(open(sys.argv[3] if len(sys.argv) > 3 else "all.csv", encoding="utf-8")) if r["class"] in ("a", "a?")]
lim = int(sys.argv[2]) if len(sys.argv) > 2 else 0
if lim: rows = rows[:lim]
t0 = time.time()
with open(sys.argv[1], "w", newline="", encoding="utf-8") as fh:
    w = csv.writer(fh); w.writerow(["path", "lines", "upstream_lines_ccc", "pct"])
    for r in rows:
        bl = subprocess.run(["git", "-C", REPO, "blame", "--line-porcelain", "-w", "-M", "-C", "-C", "-C", "HEAD", "--", r["path"]],
                            capture_output=True, text=True, encoding="utf-8", errors="replace").stdout
        a = [l[7:] for l in bl.splitlines() if l.startswith("author ")]
        u = sum(1 for x in a if x == "duongducnguyen")
        w.writerow([r["path"], len(a), u, round(100*u/len(a),1) if a else 0])
print(len(rows), round(time.time()-t0), "s")
