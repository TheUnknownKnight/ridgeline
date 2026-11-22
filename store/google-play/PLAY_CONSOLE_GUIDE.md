# Ridgeline — Google Play Console Setup Guide (`com.nickb.ridgeline`)

Everything you need to create, configure, sign, and upload **Ridgeline** (`com.nickb.ridgeline`) in [Google Play Console](https://play.google.com/console).

---

## 1. Create the App in Play Console

Click **Create app** and enter:

| Field | Value |
|---|---|
| **App name** | `Ridgeline` |
| **Default language** | `English (United States)` |
| **App or game** | `App` |
| **Free or paid** | `Free` |
| **Package / Application ID** | `com.nickb.ridgeline` *(auto-detected when you upload your first `.aab`)* |

Accept the Developer Program Policies and US export laws checkboxes, then click **Create app**.

---

## 2. Main Store Listing (Copy-Paste Ready)

Go to **Grow users -> Store presence -> Main store listing**:

- **App name:** `Ridgeline`
- **Short description** *(78 / 80 characters)*:
  ```text
  Check hiking routes against live wildfire, avalanche, weather & river hazards.
  ```
- **Full description:**
  ```text
  Ridgeline cross-references hiking and backcountry routes against live public hazard data directly on your phone — with no account, no ads, and no tracking.

  KEY FEATURES
  • Free Trail Finder & GPX Import — Search U.S. Forest Service (USFS) and National Park Service (NPS) trails by name or near your location, browse classic trails, or open any .gpx route file.
  • 8 Live Hazard Layers — Automatically checks your route corridor against NIFC active wildfire perimeters & incidents, National Weather Service (NWS) alerts, regional avalanche center forecasts (avalanche.org), NOAA/NWPS stream & river gauges, AirNow PM2.5 / AQI monitors, NAQFC smoke forecasts, Open-Meteo mountain weather forecasts, and modeled trail surface conditions (snow, ice, mud, wet rock).
  • Elevation-Aware Briefing — See an overall route severity rating (Clear through Extreme) and inspect hazards mile-by-mile along your route.
  • Offline On-Trail Mode — Save your route briefing and topographic map tiles before leaving cell service. Follow your live GPS dot, distance remaining, and upcoming hazards offline.
  • Dark-First Outdoor Design — Built for low-glare reading at the trailhead and in camp, with an optional light theme.
  • Open Source & Private — 100% free and open source (AGPL-3.0). Your phone fetches public data directly without any Ridgeline server, login, or analytics.

  IMPORTANT DISCLAIMER
  Ridgeline is an independent open-source project and is not affiliated with or endorsed by any government agency. Hazard data is summarized from publicly available sources (USFS, NPS, NWS, NIFC, NOAA/NWPS, AirNow, Open-Meteo, and avalanche.org) and may be delayed, incomplete, or inaccurate. Always verify official local land-manager notices and use sound backcountry judgment.
  ```
- **App category** *(under Store settings)*: `Maps & Navigation`
- **Store contact / Website:** `https://theunknownknight.github.io/ridgeline/`
- **Support email:** Your Google Play developer contact email

---

## 3. Store Graphics & Screenshots

Ready-to-upload graphics are already generated in this folder:

| Asset | Required Size | File in Repo |
|---|---|---|
| **App icon** | `512 × 512` PNG | `store/google-play/app-icon-512.png` |
| **Feature graphic** | `1024 × 500` PNG | `store/google-play/feature-graphic-1024x500.png` |
| **Phone screenshots** | 2–8 PNG/JPEG (9:16 portrait) | Capture 4 tabs (see below) |

### Quickest Way to Capture 4 Clean Phone Screenshots
1. Run `npm run dev` locally and open `http://localhost:5173/` in Chrome.
2. Press `F12` -> click the **Toggle device toolbar** icon (`Ctrl+Shift+M`) -> set dimensions to `390 × 844` (or `360 × 640`) and DPR `3` (gives crisp `1170 × 2532` or `1080 × 1920` PNGs).
3. Load a route (e.g., *Angels Landing* or *Half Dome*) and capture 1 screenshot of each bottom tab via Chrome DevTools menu -> **Capture screenshot**:
   1. **Explore** tab (trail search + featured classics)
   2. **Briefing** tab (overall verdict + hazard breakdown)
   3. **Map** tab (route polyline + hazard markers)
   4. **On Trail** tab (offline pack + cockpit)

---

## 4. App Content Declarations (Exact Answers)

Go to **Monitor and improve -> Policy and programs -> App content** and complete each checklist item:

| Section | Recommended Answer |
|---|---|
| **Privacy policy** | `https://theunknownknight.github.io/ridgeline/privacy.html` |
| **App access** | `All functionality is available without special access` *(no login or paywall)* |
| **Ads** | `No, my app does not contain ads` |
| **Content rating (IARC)** | Category: `Utility, Productivity, Communication, or Other` -> answer `No` to violence, mature content, social/chat, purchases -> rates **Everyone (E / PEGI 3)** |
| **Target audience** | `18 and over` *(or `13–15`, `16–17`, `18+`; do not select under 13)* |
| **News apps** | `No` |
| **Government apps** | **`No`** *(Ridgeline is an independent open-source app reading public data, not an official agency app)* |
| **Financial features** | `My app doesn't provide any financial features` |
| **Health apps** | `My app does not have any health features` |
| **Advertising ID** | `No` *(Ridgeline does not use Ad ID or ad SDKs)* |

### Data Safety Form Answers
Because `AndroidManifest.xml` declares optional `ACCESS_FINE_LOCATION` and `ACCESS_COARSE_LOCATION` (used when the user taps **Near me** or **On Trail** GPS), declare location transparently as **optional & ephemeral** so Google's manifest scanner and Data Safety form agree 100%:

1. **Does your app collect or share any of the required user data types?** -> `Yes`
2. **Is all of the user data collected by your app encrypted in transit?** -> `Yes` *(all API calls use HTTPS)*
3. **Do you provide a way for users to request that their data is deleted?** -> `No` *(data is only processed ephemerally and never stored on any developer server — select the ephemeral processing option on the next step)*
4. **Data types -> Location:** check **Approximate location** and **Precise location**:
   - **Collected:** `Yes` · **Shared:** `No`
   - **Is this data processed ephemerally?** -> **`Yes`**
   - **Required or optional?** -> **`Users can choose whether this data is collected`** *(optional — users can search trails or import GPX files without ever granting location)*
   - **Purpose:** **`App functionality`** *(only)*
5. Leave all other data categories (Personal info, Financial, Messages, Photos, Contacts, Device IDs, App activity, etc.) **unchecked**.

---

## 5. Upload Keystore & 1-Click Signed `.aab` via GitHub Actions

Google Play requires release uploads in **Android App Bundle (`.aab`)** format signed with an upload key. Keep your keystore **outside the git repository** and back it up in a password manager — if you lose it, updating the app requires a Play Console key reset.

### Step A — Generate Your Upload Keystore (Once)
Using JDK `keytool` (or Android Studio -> **Build -> Generate Signed App Bundle / APK -> Create new...**):

```powershell
mkdir "$HOME\ridgeline-keys"
keytool -genkeypair -v `
  -keystore "$HOME\ridgeline-keys\ridgeline-upload.jks" `
  -storetype PKCS12 `
  -keyalg RSA -keysize 2048 -validity 10000 `
  -alias ridgeline
```

Choose a strong keystore password and key password, and save them in your password manager.

> **Don't have `keytool` locally?** Install [Android Studio](https://developer.android.com/studio) (includes JDK + `keytool`) or [Eclipse Temurin JDK 21](https://adoptium.net/).

### Step B — Add 4 Secrets to Your GitHub Repo
1. Base64-encode the `.jks` file to your clipboard in PowerShell:
   ```powershell
   [Convert]::ToBase64String([IO.File]::ReadAllBytes("$HOME\ridgeline-keys\ridgeline-upload.jks")) | Set-Clipboard
   ```
2. On GitHub, open **TheUnknownKnight/ridgeline -> Settings -> Secrets and variables -> Actions -> New repository secret** and add:

   | Secret Name | Value |
   |---|---|
   | `ANDROID_KEYSTORE_BASE64` | Base64 string from clipboard above |
   | `ANDROID_KEYSTORE_PASSWORD` | Your keystore password |
   | `ANDROID_KEY_ALIAS` | `ridgeline` |
   | `ANDROID_KEY_PASSWORD` | Your key password |

*(For local Android Studio builds instead of GitHub Actions, create `android/key.properties` — already gitignored — with `storeFile`, `storePassword`, `keyAlias`, `keyPassword`.)*

### Step C — Build Your Signed `.aab` in 1 Click
1. Open **GitHub -> Actions -> Mobile & Web CI (com.nickb.ridgeline)**.
2. Click **Run workflow** -> set **`version_code`** to `1` *(increment to `2`, `3`, ... on every future upload)* -> click **Run workflow**.
3. When `android-release` turns green (~2 min), download the **`ridgeline-android-release-signed-aab`** artifact and unzip `app-release.aab`.

---

## 6. Upload & Release (Play App Signing + Closed Testing)

1. In Play Console, go to **Test and release -> Testing -> Closed testing** (or **Internal testing** first for instant testing on your own phone).
2. Click **Create new release**.
3. Under **App integrity / Play App Signing**, accept **Google-managed Play App Signing** *(recommended — Google signs the final APK delivered to users, and your `.jks` acts only as your upload key)*.
4. Drag and drop `app-release.aab`, enter release notes (e.g., `Initial release of Ridgeline v2.0.0 — on-device backcountry hazard briefing, trail search, and offline maps.`), and click **Next -> Save**.
5. Note for personal Google Play developer accounts created after November 2023: Google requires at least **12 testers opted in to Closed Testing for 14 continuous days** before unlocking Production publishing.

---

## Regenerating App Icons & Splashes Later

If you ever tweak the icon or feature graphic in `scripts/generate-mobile-assets.mjs`, regenerate all Android, iOS, and Play Store assets with:

```bash
npm run cap:assets
```
