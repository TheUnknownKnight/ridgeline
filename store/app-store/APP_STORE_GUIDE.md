# Ridgeline: Trail Safety — Apple App Store Setup Guide (`com.nickb.ridgeline`)

Everything you need to cloud-sign, upload via TestFlight, and submit **Ridgeline: Trail Safety** (`com.nickb.ridgeline`) to the Apple App Store from Windows — no Mac required.

---

## App & Developer Identifiers

| Field | Value |
|---|---|
| **App Store Name** | `Ridgeline: Trail Safety` |
| **Home Screen Icon Label** | `Ridgeline` *(via `CFBundleDisplayName` in `ios/App/App/Info.plist`)* |
| **Bundle ID / SKU** | `com.nickb.ridgeline` |
| **Apple Developer Team** | `Nicholas Brown` (`JVP4CMS3VH`) |
| **Target Device** | iPhone only (`TARGETED_DEVICE_FAMILY = 1`) |
| **Version (`MARKETING_VERSION`)** | `2.0.0` |
| **Support & Marketing URL** | `https://theunknownknight.github.io/ridgeline/` |
| **Privacy Policy URL** | `https://theunknownknight.github.io/ridgeline/privacy.html` |

---

## 1. Create an App Store Connect API Key (Once)

1. Open [App Store Connect -> Users and Access -> Integrations -> App Store Connect API](https://appstoreconnect.apple.com/access/integrations/api).
2. Under **Team Keys**, click **`+`** (**Generate API Key**):
   - **Name:** `Ridgeline GitHub Actions`
   - **Access:** **`Admin`** *(required for `xcodebuild -allowProvisioningUpdates` to manage cloud distribution certificates & provisioning profiles cleanly)*
3. Click **Generate**, then:
   - Copy the **Key ID** shown in the table (10 characters, e.g., `AB12CD34EF`).
   - Note your **Issuer ID** at the top of the page: `6b467ab0-d867-4dfb-8ae7-ab7f3a28572f`.
   - Click **Download** to save `AuthKey_<KEY_ID>.p8` outside the repository *(e.g. `$HOME\ridgeline-keys\AuthKey_<KEY_ID>.p8`)*. Apple only lets you download a `.p8` file **once** — keep it safe!

---

## 2. Add 3 iOS Secrets to Your GitHub Repository

1. Base64-encode the `.p8` file to your clipboard in PowerShell *(replace `<KEY_ID>` with your actual Key ID)*:
   ```powershell
   mkdir "$HOME\ridgeline-keys" -Force
   [Convert]::ToBase64String([IO.File]::ReadAllBytes("$HOME\ridgeline-keys\AuthKey_<KEY_ID>.p8")) | Set-Clipboard
   ```
2. Open **https://github.com/TheUnknownKnight/ridgeline/settings/secrets/actions -> New repository secret** and add:

   | Secret Name | Value |
   |---|---|
   | `APP_STORE_CONNECT_API_KEY_P8_BASE64` | Base64 string from clipboard above |
   | `APP_STORE_CONNECT_KEY_ID` | Your 10-character API Key ID |
   | `APP_STORE_CONNECT_ISSUER_ID` | `6b467ab0-d867-4dfb-8ae7-ab7f3a28572f` |

*(GitHub Secrets are encrypted at rest, masked in workflow logs, and only accessible to `workflow_dispatch` or `v*` tag builds — never pull requests.)*

---

## 3. Build, Cloud-Sign & Upload to TestFlight / App Store Connect (1 Click)

1. Open **https://github.com/TheUnknownKnight/ridgeline/actions/workflows/mobile-build.yml**.
2. Click **Run workflow** -> set **`ios_build_number`** to `1` *(increment to `2`, `3`, ... on every future TestFlight / App Store upload)* -> click **Run workflow**.
3. Wait ~4 minutes for **`ios-release`** (`macos-15`) to complete. It automatically:
   - Builds the web bundle and syncs Capacitor iOS.
   - Archives `App.xcodeproj` (`MARKETING_VERSION = 2.0.0`, `TARGETED_DEVICE_FAMILY = 1`, `DEVELOPMENT_TEAM = JVP4CMS3VH`).
   - Uses `ios/App/ExportOptions.plist` + Apple's cloud signing to sign and upload directly to App Store Connect, then deletes the temporary `.p8` file.

---

## 4. Test via TestFlight & Submit for Review

1. Within ~5–15 minutes after `ios-release` turns green, build `2.0.0 (1)` appears in **App Store Connect -> Ridgeline: Trail Safety -> TestFlight**.
   - Because `ITSAppUsesNonExemptEncryption` is set to `false` in `ios/App/App/Info.plist`, TestFlight skips the manual export-compliance hold.
   - Install **TestFlight** on your iPhone and add yourself to Internal Testing to verify GPS location, live hazard analysis, dark map tiles, and offline packs on a real device.
2. When ready to publish on the App Store:
   - Open **Distribution -> iOS App -> 2.0.0 Prepare for Submission**.
   - Scroll to **Build**, click **`+`**, and select your processed `2.0.0 (1)` build.
   - Verify screenshots (`store/app-store/screenshots/01-explore.png` .. `04-on-trail.png`, `1290×2796` for 6.9" iPhone), App Review Contact phone number, and review notes.
   - Click **Save**, then **Add for Review** -> **Submit to App Review**.
