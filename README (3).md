# Voxvibes International → Buffer daily queue top-up (EVERGREEN)

Standalone automation for **"Voxvibes International"** — LinkedIn Page and
Facebook Page. This shares a Buffer account with a separate LinkedIn
*Profile* channel ("khaliljerro"), but that one has its own separate repo
and different, dated content — kept apart on purpose so the two never mix.

## Evergreen content
No year folder — just month folders (`01_january`..`12_december`) directly
under the root. The same "August 1st" post is reused every year forever.
Filenames: `DD_<monabbrev><DD>_<slug>.png`.

## One-time setup

### 1. Buffer API key
This is on the same Buffer account as khaliljerro's LinkedIn Profile.
Settings → API → create/reuse a personal API key.

### 2. Google Drive API key
Reuse the one from other repos, or create a new one (Google Cloud
Console, restricted to the Drive API).

### 3. IDs you need
- `BUFFER_ORG_ID`: `6a6bb7e222ee22698fb4d1ef`
- `BUFFER_CHANNEL_IDS`: `6a6bb9654b2d03035f6eb265,6a6bb9854b2d03035f6eb2d6`
  (LinkedIn Page "voxvibes-international", Facebook Page "Voxvibes
  International")
- `ROOT_FOLDER_ID`: `1Ma1Rm6DFylpCd_88hICSAkJaFWZkF-DX`

Make sure this folder is shared as **"Anyone with the link — Viewer"**.

### 4. Minimum date (optional)
Leave `BUFFER_MIN_DATE` / `BUFFER_CHANNEL_MIN_DATES` unset unless you
manually schedule something first and want to avoid duplicates.

### 5. Create the GitHub repo and add secrets
1. New repo, e.g. `voxvibes-buffer-scheduler`.
2. Upload `schedule-voxvibes-posts.js`,
   `.github/workflows/schedule-voxvibes-posts.yml`, and this `README.md`
   (keep the `.github/workflows/` path intact).
3. Settings → Secrets and variables → Actions:

| Secret | Value |
|---|---|
| `BUFFER_API_KEY` | your Buffer API key |
| `BUFFER_ORG_ID` | `6a6bb7e222ee22698fb4d1ef` |
| `BUFFER_CHANNEL_IDS` | `6a6bb9654b2d03035f6eb265,6a6bb9854b2d03035f6eb2d6` |
| `GOOGLE_DRIVE_API_KEY` | your Drive API key |
| `ROOT_FOLDER_ID` | `1Ma1Rm6DFylpCd_88hICSAkJaFWZkF-DX` |

### 6. Test it
**Actions → "Top up Voxvibes Buffer queue" → Run workflow → check dry_run
→ Run.** Then run for real once you're happy with the log.

## Notes
- Posting time defaults to 7:00 PM Manila.
- Evergreen means no yearly maintenance — ever — as long as this same
  12-month library stays in place.
