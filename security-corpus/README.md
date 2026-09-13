# Security Reference Corpus

A local, self-updating library of publicly available cybersecurity reference material,
assembled to support **authorized** bug bounty hunting and security research alongside
ScoutIQ. Everything in it is US Government work (public domain), Creative Commons, or an
openly licensed public repository. It contains reference data only: CVE records, weakness
and attack-pattern taxonomies, testing methodology, payload libraries, wordlists, and
publicly disclosed write-ups. **No private program data, no targets.**

The corpus data is **not committed** to this repository: it is 8-12 GB and every source is
publicly re-fetchable. Git tracks only this README, the scripts and the empty layout
(`.gitignore` excludes everything else). Run `scripts/update.sh` to build or refresh it on
the machine where it lives.

## Legal and scope note (read first)

- Use this material only against systems you are explicitly authorized to test: your own
  labs, or targets in scope for a bug bounty or penetration-testing engagement. The
  program's official policy always controls authorization.
- Every cloned source keeps its upstream `LICENSE` file; the scripts never modify cloned
  content, and the update path refuses to touch a clone that has local edits.
- The Exploit-DB archive is a public record of *already disclosed* proofs of concept, kept
  for research and detection engineering. Treat it as a reference, not a launch kit.
- The scripts contact only the specific hosts listed below. Nothing is crawled.

## Layout

```text
security-corpus/
├── vulnerability-data/
│   ├── nvd/               # CVE records, one JSON (+ .xz) per year 1999-today; recent/ for API deltas
│   ├── cisa-kev/          # CISA Known Exploited Vulnerabilities (JSON + CSV)
│   └── epss/              # (optional) FIRST EPSS exploit-probability scores, daily CSV
├── frameworks/
│   ├── mitre-attack/      # ATT&CK Enterprise / Mobile / ICS, STIX 2.1 bundles
│   ├── mitre-cwe/         # Common Weakness Enumeration (zip + extracted XML)
│   └── mitre-capec/       # Common Attack Pattern Enumeration and Classification
├── methodology/
│   ├── owasp-wstg/        # Web Security Testing Guide
│   ├── owasp-asvs/        # Application Security Verification Standard
│   ├── owasp-top10/       # OWASP Top 10
│   ├── owasp-cheatsheets/ # OWASP Cheat Sheet Series
│   └── payloadsallthethings/
├── wordlists/
│   └── seclists/
├── writeups/
│   ├── awesome-bugbounty-writeups/
│   ├── bug-bounty-reference/
│   └── bugbounty-cheatsheet/
├── exploits-reference/
│   └── exploitdb/         # Public archive of disclosed PoCs (OffSec)
├── scripts/
│   ├── fetch_data.py      # direct-download sources (feeds, KEV, EPSS, ATT&CK, CWE, CAPEC)
│   ├── clone_repos.sh     # shallow git clones / updates
│   └── update.sh          # runs both, stamps .last-update, refreshes the status below
├── manifest.json          # generated: URL, ETag, SHA-256, size, fetch time per data file
├── .last-update           # generated: timestamp of the last update.sh run
└── README.md
```

## Sources and licenses

### Vulnerability data

| Source | What it is | Fetched from | Fallback | License |
|---|---|---|---|---|
| **NVD CVE feeds** (FKIE mirror) | Complete CVE dataset as reconstructed legacy JSON feeds, rebuilt daily at 00:00 UTC | `github.com/fkie-cad/nvd-json-data-feeds` release assets `CVE-<year>.json.xz` | none needed | NVD data: US Government, public domain. Mirror tooling: MIT |
| **NVD 2.0 API** (optional) | Same data, queryable; used for same-day deltas with `--nvd-api-days` | `services.nvd.nist.gov/rest/json/cves/2.0` | - | Public domain |
| **CISA KEV** | Vulnerabilities known to be exploited in the wild | `www.cisa.gov/.../known_exploited_vulnerabilities.{json,csv}` | GitHub mirror `github.com/cisagov/kev-data` | CC0 |
| **EPSS** (optional) | Daily probability-of-exploitation score per CVE | Link resolved from `www.first.org/epss/` (the host has moved before); currently `epss.empiricalsecurity.com` | - | Free to use with attribution to FIRST |

### Frameworks and taxonomies

| Source | What it is | Fetched from | Fallback | License |
|---|---|---|---|---|
| **MITRE ATT&CK** | Adversary tactics and techniques, STIX 2.1 | `github.com/mitre-attack/attack-stix-data` (`enterprise-attack`, `mobile-attack`, `ics-attack`) | - | MITRE ATT&CK terms of use: free use with attribution |
| **MITRE CWE** | Weakness taxonomy | `cwe.mitre.org/data/xml/cwec_latest.xml.zip` (XML extracted alongside) | - | Free public use with attribution (MITRE terms of use) |
| **MITRE CAPEC** | Attack-pattern catalog | `capec.mitre.org/data/xml/capec_latest.xml` | STIX 2.1 bundle from `github.com/mitre/cti` (`stix-capec.json`) | Free public use with attribution (MITRE terms of use) |

### Methodology, payloads, wordlists (shallow git clones)

| Repository | What it is | License (upstream file) |
|---|---|---|
| `github.com/OWASP/wstg` | Web Security Testing Guide, the canonical web-app testing methodology | CC BY-SA 4.0 (`LICENSE`) |
| `github.com/OWASP/ASVS` | Application Security Verification Standard | CC BY-SA 4.0 (`LICENSE.md`) |
| `github.com/OWASP/Top10` | OWASP Top 10 | CC BY-SA 4.0 (`LICENSE`) |
| `github.com/OWASP/CheatSheetSeries` | Concise per-topic application-security guidance | CC BY-SA 4.0 (`LICENSE.md`) |
| `github.com/swisskyrepo/PayloadsAllTheThings` | Payloads and bypasses per vulnerability class | MIT (`LICENSE`) |
| `github.com/danielmiessler/SecLists` | Wordlists for discovery, fuzzing and credentials (**large**) | MIT (`LICENSE`) |

### Disclosed write-ups and references (shallow git clones)

| Repository | What it is | License (upstream file) |
|---|---|---|
| `github.com/devanshbatham/Awesome-Bugbounty-Writeups` | Curated write-ups organized by bug class | No license file upstream; a curated list of links to publicly disclosed reports |
| `github.com/ngalongc/bug-bounty-reference` | Write-ups categorized by vulnerability nature | No license file upstream; a curated list of links to publicly disclosed reports |
| `github.com/edoverflow/bugbounty-cheatsheet` | Payloads, tips and tricks for hunters | CC BY-SA 4.0 (`LICENSE`) |

### Exploit reference archive

| Source | What it is | Fetched from | License |
|---|---|---|---|
| **Exploit-DB** | Public archive of disclosed exploits and PoCs (the `searchsploit` database), **large** | `gitlab.com/exploit-database/exploitdb` | GPL-2.0 (`LICENSE.md`) for the archive and tooling; individual exploits remain their authors' work. Upstream notices are kept as cloned |

**Not included** because they need their hosted lab environments: PortSwigger Web Security
Academy (`portswigger.net/web-security`) and Hacker101 (`hacker101.com`,
`hackerone.com/hacktivity`). Bookmark them.

## Usage

```bash
cd security-corpus
scripts/update.sh                    # first build and every later refresh (both fetchers + README status)
scripts/update.sh --nvd-api-days 7   # additionally pull same-week CVE deltas from the NVD 2.0 API
scripts/update.sh --no-decompress    # keep only the .xz CVE feeds (about a tenth of the space)

python3 scripts/fetch_data.py --help  # run the data fetch alone; --only nvd|kev|attack|cwe|capec|epss
bash scripts/clone_repos.sh           # run the git clones/updates alone
python3 scripts/fetch_data.py --status   # print the status tables below (no network)
```

Requirements: Python 3.9+ (standard library only), git 2.x, bash, `du`, `awk`. No API key
is needed for the default path. For the optional NVD 2.0 API path, request a free key at
<https://nvd.nist.gov/developers/request-an-api-key> and export it as `NVD_API_KEY`; the
key is only ever read from the environment. Without a key the API allows about
5 requests per 30 s, with one about 50; the script paces itself accordingly.

Schedule a weekly refresh (Linux/macOS cron; daily is fine for the feeds):

```cron
0 3 * * 0  /path/to/security-corpus/scripts/update.sh >> /path/to/security-corpus/update.log 2>&1
```

The CVE feeds and CISA KEV change most often; ATT&CK, CWE and CAPEC a few times a year;
the git repositories continuously. If space is tight, delete the decompressed
`CVE-<year>.json` files and run with `--no-decompress`; the `.xz` archives are kept
regardless.

## How the scripts behave

- **Idempotent.** `fetch_data.py` sends `If-None-Match` / `If-Modified-Since` for every
  file it already has; an unchanged origin answers 304 and nothing is written. Repositories
  that are already current report "up to date".
- **Resumable.** Downloads stream to `<file>.part` and are renamed into place only when
  complete; a cut-off transfer resumes with an HTTP `Range` request on the next attempt or
  run. Transient errors retry with exponential backoff (2, 4, 8, 16 s); a host that is
  unreachable (DNS failure or an egress proxy refusing it) fails fast instead.
- **Verified.** Archives are checked before they are accepted: `.xz` feeds are decompressed
  through liblzma (CRC-checked) and must be a JSON object, the CWE zip passes
  `zipfile.testzip()`, EPSS gzip is fully inflated, JSON/STIX documents must parse and
  contain the expected top-level array, and `Content-Length` must match. Every accepted
  file's URL, ETag, SHA-256, size and record count go to `manifest.json`.
- **Mirrors only where the brief names one.** CISA KEV falls back to the
  `cisagov/kev-data` GitHub mirror and CAPEC to the STIX bundle in `mitre/cti` when the
  primary host cannot be reached; the manifest and the status table record which one
  served the file. CWE and EPSS have no in-brief mirror, so they simply report failure on
  a network that blocks `cwe.mitre.org` or `first.org`; re-running later picks them up.
- **Shallow clones stay shallow.** `clone_repos.sh` clones with `--depth=1
  --single-branch --no-tags`, and updates with `git fetch --depth=1` followed by
  `git reset --hard FETCH_HEAD` plus a prune. (`git pull --depth=1 --ff-only` cannot
  fast-forward a depth-1 clone once upstream has moved, because the new tip has no
  parents locally.) A clone with local modifications is skipped rather than reset; set
  `CORPUS_FORCE_RESET=1` to discard them.
- **Polite.** One User-Agent identifying this fetcher, at least 0.5 s between requests to
  the same host, `Retry-After` honored, NVD API paging paced to its published limits.

## Status

<!-- status:start -->
_Last updated: 2026-09-13 12:35 UTC. Generated by `scripts/fetch_data.py --status`; `scripts/update.sh` refreshes it._

**Data feeds** (provenance in `manifest.json`)

| Dataset | File(s) | Served by | Size | Fetched (UTC) | Details |
|---|---|---|---|---|---|
| NVD CVE feeds 1999-2026 (28 years) | `vulnerability-data/nvd/CVE-<year>.json(.xz)` | github.com (FKIE mirror) | 3.0 GB | 2026-09-13 12:32 | 390,663 CVEs, feed built 2026-09-13 00:00 |
| CISA KEV (JSON) | `vulnerability-data/cisa-kev/known_exploited_vulnerabilities.json` | raw.githubusercontent.com (mirror) | 1.6 MB | 2026-09-13 12:30 | catalog 2026.09.11, released 2026-09-11T19:32:16.8993Z, 1,709 entries |
| CISA KEV (CSV) | `vulnerability-data/cisa-kev/known_exploited_vulnerabilities.csv` | raw.githubusercontent.com (mirror) | 985.0 KB | 2026-09-13 12:30 | 1,709 entries |
| ATT&CK Enterprise | `frameworks/mitre-attack/enterprise-attack.json` | raw.githubusercontent.com | 51.3 MB | 2026-09-13 12:32 | 858 attack patterns, modified 2026-08-05T21:33:58.496Z, 26,086 STIX objects, version 19.2 |
| ATT&CK Mobile | `frameworks/mitre-attack/mobile-attack.json` | raw.githubusercontent.com | 5.5 MB | 2026-09-13 12:32 | 190 attack patterns, modified 2026-08-05T21:34:50.442Z, 2,635 STIX objects, version 19.2 |
| ATT&CK ICS | `frameworks/mitre-attack/ics-attack.json` | raw.githubusercontent.com | 3.9 MB | 2026-09-13 12:32 | 118 attack patterns, modified 2026-08-05T21:34:28.409Z, 2,173 STIX objects, version 19.2 |
| CWE | `frameworks/mitre-cwe/cwec_latest.xml.zip` | | | | not fetched |
| CAPEC (XML) | `frameworks/mitre-capec/capec_latest.xml` | | | | not fetched |
| CAPEC (STIX 2.1, mitre/cti mirror) | `frameworks/mitre-capec/stix-capec.json` | raw.githubusercontent.com (mirror) | 4.3 MB | 2026-09-13 12:30 | 615 attack patterns, 2,666 STIX objects |

<details><summary>NVD feed per year</summary>

| Year | CVEs | .xz | .json | Feed built | Fetched (UTC) |
|---|---|---|---|---|---|
| 1999 | 1,579 | 205.9 KB | 5.4 MB | 2026-09-13 00:00 | 2026-09-13 12:30 |
| 2000 | 1,243 | 202.4 KB | 4.9 MB | 2026-09-13 00:00 | 2026-09-13 12:30 |
| 2001 | 1,556 | 304.5 KB | 6.7 MB | 2026-09-13 00:00 | 2026-09-13 12:31 |
| 2002 | 2,393 | 555.6 KB | 12.0 MB | 2026-09-13 00:00 | 2026-09-13 12:31 |
| 2003 | 1,555 | 417.9 KB | 8.4 MB | 2026-09-13 00:00 | 2026-09-13 12:31 |
| 2004 | 2,707 | 763.6 KB | 17.6 MB | 2026-09-13 00:00 | 2026-09-13 12:31 |
| 2005 | 4,770 | 1.1 MB | 27.6 MB | 2026-09-13 00:00 | 2026-09-13 12:31 |
| 2006 | 7,145 | 1.9 MB | 43.7 MB | 2026-09-13 00:00 | 2026-09-13 12:31 |
| 2007 | 6,580 | 2.0 MB | 41.7 MB | 2026-09-13 00:00 | 2026-09-13 12:31 |
| 2008 | 7,179 | 2.2 MB | 48.5 MB | 2026-09-13 00:00 | 2026-09-13 12:31 |
| 2009 | 5,054 | 1.8 MB | 47.1 MB | 2026-09-13 00:00 | 2026-09-13 12:31 |
| 2010 | 5,249 | 1.7 MB | 50.9 MB | 2026-09-13 00:00 | 2026-09-13 12:31 |
| 2011 | 4,899 | 1.6 MB | 50.5 MB | 2026-09-13 00:00 | 2026-09-13 12:31 |
| 2012 | 5,939 | 1.9 MB | 58.9 MB | 2026-09-13 00:00 | 2026-09-13 12:31 |
| 2013 | 6,830 | 2.0 MB | 64.5 MB | 2026-09-13 00:00 | 2026-09-13 12:31 |
| 2014 | 9,002 | 2.2 MB | 59.2 MB | 2026-09-13 00:00 | 2026-09-13 12:31 |
| 2015 | 8,779 | 2.0 MB | 59.1 MB | 2026-09-13 00:00 | 2026-09-13 12:31 |
| 2016 | 10,647 | 2.4 MB | 75.1 MB | 2026-09-13 00:00 | 2026-09-13 12:31 |
| 2017 | 17,105 | 3.6 MB | 109.0 MB | 2026-09-13 00:00 | 2026-09-13 12:31 |
| 2018 | 17,817 | 3.7 MB | 116.5 MB | 2026-09-13 00:00 | 2026-09-13 12:31 |
| 2019 | 17,623 | 4.4 MB | 136.1 MB | 2026-09-13 00:00 | 2026-09-13 12:31 |
| 2020 | 21,075 | 5.2 MB | 180.2 MB | 2026-09-13 00:00 | 2026-09-13 12:31 |
| 2021 | 23,468 | 6.7 MB | 215.4 MB | 2026-09-13 00:00 | 2026-09-13 12:32 |
| 2022 | 27,553 | 8.0 MB | 237.0 MB | 2026-09-13 00:00 | 2026-09-13 12:32 |
| 2023 | 31,411 | 8.6 MB | 272.4 MB | 2026-09-13 00:00 | 2026-09-13 12:32 |
| 2024 | 39,240 | 11.6 MB | 317.5 MB | 2026-09-13 00:00 | 2026-09-13 12:32 |
| 2025 | 45,255 | 10.7 MB | 305.9 MB | 2026-09-13 00:00 | 2026-09-13 12:32 |
| 2026 | 57,010 | 14.5 MB | 371.1 MB | 2026-09-13 00:00 | 2026-09-13 12:32 |

</details>

**Git repositories** (shallow clones, `--depth=1`)

| Repository | Local path | Commit | Committed | Size |
|---|---|---|---|---|
| [github.com/OWASP/ASVS](https://github.com/OWASP/ASVS) | `methodology/owasp-asvs/` | `2b30071` | 2026-09-03 | 259.9 MB |
| [github.com/OWASP/CheatSheetSeries](https://github.com/OWASP/CheatSheetSeries) | `methodology/owasp-cheatsheets/` | `030528e` | 2026-09-11 | 36.7 MB |
| [github.com/OWASP/Top10](https://github.com/OWASP/Top10) | `methodology/owasp-top10/` | `66ebc47` | 2026-08-05 | 437.5 MB |
| [github.com/OWASP/wstg](https://github.com/OWASP/wstg) | `methodology/owasp-wstg/` | `3da95e4` | 2026-09-12 | 26.5 MB |
| [github.com/swisskyrepo/PayloadsAllTheThings](https://github.com/swisskyrepo/PayloadsAllTheThings) | `methodology/payloadsallthethings/` | `3ac2790` | 2026-08-27 | 21.7 MB |
| [github.com/danielmiessler/SecLists](https://github.com/danielmiessler/SecLists) | `wordlists/seclists/` | `810736b` | 2026-09-13 | 2.5 GB |
| [github.com/devanshbatham/Awesome-Bugbounty-Writeups](https://github.com/devanshbatham/Awesome-Bugbounty-Writeups) | `writeups/awesome-bugbounty-writeups/` | `7201006` | 2023-08-06 | 356.0 KB |
| [github.com/ngalongc/bug-bounty-reference](https://github.com/ngalongc/bug-bounty-reference) | `writeups/bug-bounty-reference/` | `6a562dd` | 2024-08-01 | 248.0 KB |
| [github.com/edoverflow/bugbounty-cheatsheet](https://github.com/edoverflow/bugbounty-cheatsheet) | `writeups/bugbounty-cheatsheet/` | `14a70dc` | 2021-01-15 | 348.0 KB |
| [gitlab.com/exploit-database/exploitdb](https://gitlab.com/exploit-database/exploitdb) | `exploits-reference/exploitdb/` | `150aef0e` | 2026-09-12 | 359.0 MB |

**Storage**

| Folder | Size |
|---|---|
| `exploits-reference/` | 359.0 MB |
| `frameworks/` | 65.0 MB |
| `methodology/` | 782.4 MB |
| `vulnerability-data/` | 3.0 GB |
| `wordlists/` | 2.5 GB |
| `writeups/` | 956.0 KB |
| **total** | **6.6 GB** |
<!-- status:end -->
