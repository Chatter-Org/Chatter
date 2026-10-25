# Releasing the Android app

Releases are signed APKs, built by GitHub Actions
(`.github/workflows/mobile-release.yml`) and installed by hand. No Play Store.

## The signing key (once)

Android only installs an update over an app signed with the **same key**. Lose
the key and nobody can update: they have to uninstall (losing their session)
and install again. So it is made once, kept safe, and never committed.

1. **Make it.** In a terminal, in a folder outside the repository. `keytool`
   comes with any JDK; it is rarely on the PATH, so this calls Android
   Studio's by its full path:

   ```powershell
   & "C:\Program Files\Android\Android Studio\jbr\bin\keytool.exe" -genkeypair -v -keystore chatter-upload.jks -alias chatter -keyalg RSA -keysize 4096 -validity 10000
   ```

   It asks for a keystore password (twice), then your name and organisation
   (anything true is fine; they are embedded in the certificate, not shown to
   users). It does not ask for a separate key password: the file is PKCS12,
   where the key's password is the keystore's.

2. **Keep it.** Put `chatter-upload.jks` and its password in your password
   manager, or another backed-up place only you and the project owner can
   reach. This is the copy that matters; the GitHub secret is not a backup.

3. **Give it to GitHub.** Encode the file and copy it, from the same folder
   (the full path because .NET does not follow PowerShell's `cd`):

   ```powershell
   [Convert]::ToBase64String([IO.File]::ReadAllBytes("$PWD\chatter-upload.jks")) | Set-Clipboard
   ```

   Then in the repository on GitHub: **Settings → Secrets and variables →
   Actions → New repository secret**, four times (only a repository admin can):

   | Name | Value |
   |---|---|
   | `CHATTER_KEYSTORE_BASE64` | the clipboard from above |
   | `CHATTER_KEYSTORE_PASSWORD` | the keystore password |
   | `CHATTER_KEY_ALIAS` | `chatter` |
   | `CHATTER_KEY_PASSWORD` | the keystore password again |

## A test build

**Actions → Mobile release → Run workflow** on `main`. When it finishes, the
run's page has the APK under **Artifacts**. Install it with
`adb install -r chatter-0.0.0-run.N.apk`, or copy it to the phone and open it.

Release builds are minified by R8 and development builds are not, so a
release can fail where development worked (usually code found by name at run
time: the native modules, WebRTC). Open the test build and go through sign-in,
a call, and a share before tagging anything.

The release app (`io.zgaf.chatter`, "Chatter") installs beside the
development build (`io.zgaf.chatter.dev`, "Chatter Dev"); they don't touch each
other.

## A release

First the notes. In `CHANGELOG.md`, rename "Unreleased" to the version and
date (`## 0.2.0 — November 2, 2026`), run `npm run changelog` so the app's
Settings → What's new matches, and commit.

Then tag the commit and push the tag:

```bash
git tag mobile-v0.2.0
git push origin mobile-v0.2.0
```

The workflow builds it and creates a GitHub Release, "Chatter for Android
0.2.0", with `chatter-0.2.0.apk` attached and that version's section of
`CHANGELOG.md` as its notes (the commit list if it has none): the text to share.
Each build's `versionCode` is the workflow's run number, which only grows, so
every build installs over the one before.

Before tagging: the server the release talks to must already have every server
change the app relies on. Apps installed earlier keep running against newer
servers, so server changes stay backward compatible.
