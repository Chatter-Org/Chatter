"""Fail a release build whose native code names a class R8 renamed or removed.

Native libraries find some Java classes by name at run time (JNI's FindClass,
or Class.forName). R8 shrinks and renames release builds, and does not read
native code, so a class known only by name there can be renamed or removed
without any build error. The app then aborts at start-up — the first release
did exactly that, on org.jni_zero.JniZero. The fix is a keep rule
(app.config.ts, extraProguardRules); this finds the classes that need one.

usage: python3 check-native-names.py <apk> <mapping-dir>
  mapping-dir: android/app/build/outputs/mapping/release
"""
import os
import re
import sys
import zipfile

apk, mapping_dir = sys.argv[1:3]

# mapping.txt: "original.Name -> renamed:" for every class R8 kept.
kept = {}
with open(os.path.join(mapping_dir, "mapping.txt"), encoding="utf-8") as f:
    for line in f:
        if line.startswith((" ", "#")):
            continue
        m = re.match(r"(\S+) -> (\S+):", line)
        if m:
            kept[m.group(1)] = m.group(2)

# usage.txt: classes R8 removed entirely, one per unindented line.
removed = set()
with open(os.path.join(mapping_dir, "usage.txt"), encoding="utf-8") as f:
    for line in f:
        if line.strip() and not line.startswith(" "):
            removed.add(line.strip().rstrip(":"))

# Class names as JNI writes them (slashes) or Class.forName takes them (dots):
# a lowercase package path ending in a capitalised class name.
pattern = re.compile(rb"(?<![A-Za-z0-9_/.$])((?:[a-z][a-z0-9_]*[/.])+[A-Z][A-Za-z0-9_$]*)")
platform = ("java.", "javax.", "android.", "dalvik.", "libcore.", "sun.")

named = {}
with zipfile.ZipFile(apk) as z:
    for entry in z.namelist():
        if entry.startswith("lib/") and entry.endswith(".so"):
            for m in pattern.finditer(z.read(entry)):
                cls = m.group(1).decode().replace("/", ".")
                if not cls.startswith(platform):
                    named.setdefault(cls, set()).add(os.path.basename(entry))

# A name that is neither kept nor removed is not a class in this app (a
# string that only looks like one), and is ignored.
problems = []
for cls in sorted(named):
    if cls in kept and kept[cls] != cls:
        problems.append(f"renamed  {cls} -> {kept[cls]}")
    elif cls not in kept and cls in removed:
        problems.append(f"removed  {cls}")

print(f"{len(named)} class names found in native code")
for p in problems:
    cls = p.split()[1]
    print(f"::error::R8 {p} (named in {', '.join(sorted(named[cls]))}). Add a -keep rule in app.config.ts.")
sys.exit(1 if problems else 0)
