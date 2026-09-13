# Source and permission evidence register

Inspection date for everything in this file: **2026-09-13** (design sandbox). Nothing here is an observed acquisition result.

## 0. How to read this register

### 0.1 Evidence classes

| Class | Meaning | Weight in permission decisions |
|---|---|---|
| **A** | Primary page or API response fetched from the source host in this sandbox | Sufficient for an automatic decision when the rule's other conditions hold |
| **B** | Primary text obtained from the source's own official code repository or an official distribution channel (GitHub repository of the project, PyPI source distribution, Creative Commons legal-tools data repository) | Sufficient for interface and licence-text facts; not item-level permission |
| **C** | Secondary: search-engine result snippets or summaries of the primary page, or third-party pages | Supports a proposal only; item stays `needs_review` until class A evidence is captured |
| **D** | Recalled or inferred; not verified in this sandbox | Never used for a decision; listed so it is re-checked |

### 0.2 Network limitation of the design sandbox (report of what could not be inspected)

The sandbox's egress proxy answered `403` to CONNECT for every host below. `WebFetch` returned `EGRESS_BLOCKED` for the same hosts. This is an environment limitation, not evidence about the sites.

| Host | Requested for | Result |
|---|---|---|
| `www.openbookpublishers.com`, `books.openbookpublishers.com`, `cdn.openbookpublishers.com` | home page, open-metadata page, book pages, FAQ, policies, robots.txt | blocked |
| `thoth.pub`, `api.thoth.pub`, `export.thoth.pub` | metadata terms page, GraphQL API, export API | blocked |
| `www.rifters.com` | *Blindsight* page, backlist permissions | blocked |
| `authorsguild.org` | background article on the selected site | blocked |
| `oceanofpdf.com` | robots.txt and terms only (no crawl intended) | blocked |
| `sqlite.org`, `www.sqlite.org`, `pypdf.readthedocs.io`, `docs.python.org` | implementation documentation | blocked |
| `creativecommons.org`, `copyright.gov.in`, `indiacode.nic.in` | licence and statute text | blocked |
| `library.oapen.org`, `directory.doabooks.org`, `api.crossref.org`, `doi.org`, `openlibrary.org`, `api.openalex.org`, `archive.org`, `web.archive.org`, `index.commoncrawl.org` | alternative catalogue or archival routes | blocked |

Reachable: `raw.githubusercontent.com` (public repository files), `pypi.org` and `files.pythonhosted.org` (source distributions), the built-in web search tool, and `www.googleapis.com` (Google Books API answered `429 Too Many Requests` without a key; not used).

Consequence: **no item-level licence was verified against a primary page in this sandbox.** All item decisions below are `needs_review` with a specified automatic path to `eligible` in stage 2.

## 1. Source register

### 1.1 Open Book Publishers (OBP), `https://www.openbookpublishers.com/`

| Aspect | Observation | Class | Evidence URL |
|---|---|---|---|
| Publisher policy | Search summaries of OBP pages: "All of Open Book Publishers' books are free to read and download online from the date of publication" and "permanently and freely available under an open licence to download or read online in PDF and HTML formats"; "All ... digital editions are free from DRM". | C | `https://www.openbookpublishers.com/about/faq`, `https://www.openbookpublishers.com/about/our-vision` |
| Default licence | Search summary: OBP "publishes under the CC BY 4.0 International License". Individual books can carry other licences; **licence is checked per work, never inferred from the publisher default.** | C | `https://www.openbookpublishers.com/about` |
| EPUB cost | Conflicting secondary statements: one library-consortium page says unlimited free downloads "in PDF, ePub, Mobi or HTML formats" through the OBP website; a Wikipedia summary says HTML, PDF and XML are free while "EPUB and MOBI digital editions ... are available for purchase". Treated as unknown. | C | `https://eifl.net/e-resources/open-book-publishers-e-books`, `https://en.wikipedia.org/wiki/Open_Book_Publishers` |
| Open metadata page | Not fetchable. Search results confirm the page exists and that OBP's metadata is managed in Thoth and released as CC0. An open metadata licence does **not** license any book's text. | C | `https://www.openbookpublishers.com/open-software/open-metadata`, `https://www.openbookpublishers.com/libraries/marc-records` |
| Landing-page URL pattern | Observed in search-result URLs: `https://www.openbookpublishers.com/books/10.11647/obp.0125`, `.../books/10.11647/obp.0168`, chapter pages `.../books/10.11647/obp.0383/chapters/10.11647/obp.0383.25` | C (URL strings only) | as listed |
| File-host URL pattern | Observed in search-result URLs: `https://books.openbookpublishers.com/10.11647/obp.0125.pdf`, `.../obp.0102.pdf`, `.../obp.0168.pdf`, `.../obp.0308.pdf`, `.../obp.0321.pdf`, chapter files `.../obp.0172.05.pdf`; HTML edition `https://books.openbookpublishers.com/10.11647/obp.0168/` with `about.xhtml`; assets on `cdn.openbookpublishers.com` | C (URL strings only) | as listed |
| Mirror copies | OAPEN hosts a copy of D1: `https://library.oapen.org/bitstream/id/4e47582f-1f98-4501-9012-a62b16f6e251/638898.pdf` (search result). Not used in the pilot; OBP's own host is the canonical route. | C | as listed |
| robots.txt, terms of use | Not fetchable. Search found `https://www.openbookpublishers.com/policies/privacy` and `.../policies/information`; no terms-of-use page surfaced. | C / unknown | as listed |
| Automation rules | Unknown. Pilot uses the documented machine interface (Thoth) for enumeration and fetches only the specific `fullTextUrl` files, at one request per 2 seconds, after checking robots.txt at runtime. | — | — |

Decision for the source profile `obp_thoth` v1: **approved for pilot enumeration and file transfer**, conditional on (i) runtime robots.txt allowing the file paths, (ii) per-item licence evidence from Thoth, (iii) post-download embedded-licence agreement.

### 1.2 Thoth open metadata (catalogue interface for OBP)

Primary documentation pages (`https://thoth.pub/docs`, `https://thoth.pub/docs/policies/terms-thoth-metadata`) were not fetchable. The interface below was read from the Thoth source repository, which the sandbox could clone anonymously.

| Item | Value | Class |
|---|---|---|
| Repository and commit inspected | `https://github.com/thoth-pub/thoth`, commit `4fa7eaa9ccb60d39c41ccd8feb257edf28c173ff` (2026-09-04) | B |
| GraphQL endpoint | `https://api.thoth.pub/graphql` (README and `thoth-client/src/lib.rs`); GraphiQL explorer at `https://api.thoth.pub/graphiql` | B |
| Export (REST) endpoint | `https://export.thoth.pub` (README; RapiDoc UI at `/`, OpenAPI at `/openapi.json`) | B |
| Export routes (`thoth-export-server/src/specification/mod.rs`, `format/mod.rs`, `platform/mod.rs`) | `GET /specifications/`, `GET /specifications/{specification_id}`, `GET /specifications/{specification_id}/work/{work_id}`, `GET /specifications/{specification_id}/publisher/{publisher_id}`, `GET /formats/`, `GET /formats/{format_id}`, `GET /platforms/`, `GET /platforms/{platform_id}` | B |
| Specification identifiers (`thoth-export-server/src/data.rs`) | `onix_3.1::thoth`, `onix_3.0::thoth`, `onix_3.0::project_muse`, `onix_3.0::oapen`, `onix_3.0::jstor`, `onix_3.0::google_books`, `onix_3.0::overdrive`, `onix_2.1::ebsco_host`, `onix_2.1::proquest_ebrary`, `csv::thoth`, `json::thoth`, `kbart::oclc`, `bibtex::thoth`, `doideposit::crossref`, `marc21record::thoth`, `marc21markup::thoth`, `marc21xml::thoth` | B |
| Root query `works` (`thoth-api/src/graphql/query.rs`) | arguments `limit` (default 100), `offset` (default 0), `filter` (string; documented as "a test, do not rely on it": case-insensitive literal search on full_title, doi, reference, abstracts, landing_page), `order`, `publishers: [Uuid]` ("only shows results connected to publishers with these IDs"), `workTypes`, `workStatuses`, `publicationDate`, `updatedAtWithRelations` | B |
| Root query `workByDoi(doi)` | "Query a single work using its DOI"; DOI type is a full URL `https://doi.org/10.11647/obp.0001` (field description in `graphql/model.rs`) | B |
| Root query `publishers` | `limit`, `offset`, `filter` (literal search on publisher_name and publisher_shortname), `order`, `publishers` | B |
| `Work` fields relevant to the pilot | `workId`, `workType`, `workStatus`, `edition`, `doi`, `publicationDate`, `withdrawnDate`, `license` ("URL of the license which applies to this work (frequently a Creative Commons license for open-access works)"), `copyrightHolder`, `landingPage` ("URL of the web page of the work"), `fullTitle`, `title`, `subtitle`, `pageCount`, `contributions { fullName firstName lastName contributionType mainContribution contributionOrdinal }`, `languages { languageCode languageRelation }`, `publications { publicationId publicationType isbn locations { landingPage fullTextUrl locationPlatform canonical checksum checksumAlgorithm } }`, `imprint { imprintName publisher { publisherId publisherName } }` | B |
| `Location` field descriptions | `fullTextUrl`: "Direct link to the full text file"; `canonical`: "Whether this is the canonical location for this specific publication (e.g. ... the official version of record hosted on the publisher's own web server)"; `checksum`: "Checksum of the full text file as returned by the platform"; `checksumAlgorithm`: "MD5, SHA-256 or SHA-1" | B |
| Enumerations | `PublicationType`: Paperback, Hardback, PDF, HTML, XML, Epub, Mobi, AZW3, DOCX, FictionBook, MP3, WAV. `LocationPlatform`: ProjectMuse, Oapen, Doab, Jstor, EbscoHost, OclcKb, ProquestKb, ProquestExlibris, EbscoKb, JiscKb, GoogleBooks, InternetArchive, ScienceOpen, ScieloBooks, Zenodo, PublisherWebsite, Thoth, Other. `WorkStatus`: Forthcoming, Active, Withdrawn, Superseded, PostponedIndefinitely, Cancelled. `WorkType`: BookChapter, Monograph, EditedBook, Textbook, JournalIssue, BookSet. GraphQL spells enum values in upper snake case (for example `PDF`, `EPUB`, `PUBLISHER_WEBSITE`, `ACTIVE`); confirm in GraphiQL "Docs". | B (names), D (GraphQL spelling) |
| Rate limits | No rate-limiting middleware found in the server sources (grep for rate limit, governor, throttle). Live limits unknown. | B (absence in code) |
| Metadata licence | Search summaries of thoth.pub pages: "All metadata records are released openly under a CC0 public-domain dedication via Thoth's GraphQL and Export APIs, the public catalogue, and through its OAI-PMH endpoint." The terms page itself was not read. | C | 
| OBP publisher UUID | Not observed. Resolve at runtime with `publishers(filter: "Open Book Publishers")` and pin with evidence. | D |

Working query templates (built from the fields above; **proposed until executed against the live API**):

```graphql
query FindPublisher($name: String!) {
  publishers(filter: $name, limit: 10) { publisherId publisherName publisherShortname publisherUrl }
}

query WorkByDoi($doi: Doi!) {
  workByDoi(doi: $doi) {
    workId workType workStatus edition doi publicationDate withdrawnDate
    fullTitle title subtitle license copyrightHolder landingPage pageCount
    contributions(order: {field: CONTRIBUTION_ORDINAL, direction: ASC}) {
      fullName firstName lastName contributionType mainContribution contributionOrdinal
    }
    languages { languageCode languageRelation }
    publications {
      publicationId publicationType isbn
      locations { landingPage fullTextUrl locationPlatform canonical checksum checksumAlgorithm }
    }
    imprint { imprintName publisher { publisherId publisherName } }
  }
}

query WorksForPublisher($publishers: [Uuid!], $limit: Int!, $offset: Int!) {
  works(publishers: $publishers, limit: $limit, offset: $offset, workStatuses: [ACTIVE]) {
    workId doi fullTitle license publicationDate workType
    contributions { fullName contributionType mainContribution }
    languages { languageCode languageRelation }
    publications { publicationType isbn locations { fullTextUrl locationPlatform canonical } }
  }
}
```

Requests are `POST https://api.thoth.pub/graphql` with a JSON body `{"query": ..., "variables": ...}`; responses carry `data` and optionally `errors`. The `Doi` scalar accepts the full `https://doi.org/...` form; whether it also accepts a bare DOI must be checked in GraphiQL.

### 1.3 Peter Watts, author-hosted *Blindsight* and backlist (`https://www.rifters.com/`)

| Aspect | Observation | Class | Evidence URL |
|---|---|---|---|
| Edition page | Exists: "Blindsight by Peter Watts". Full text offered in several formats; PDF at `https://www.rifters.com/real/shorts/PeterWatts_Blindsight.pdf`; endnotes at `https://rifters.com/real/shorts/PeterWatts_Blindsight_Endnotes.pdf`; older HTML edition under `https://rifters.com/blindsight/`. | C | `https://www.rifters.com/real/Blindsight.htm` |
| Licence | Search summaries: released under Creative Commons Attribution-NonCommercial-ShareAlike; the version named in the endnotes is 2.5. Exact wording of the licence block on the page and inside the files not read. | C | same, plus `https://www.rifters.com/real/shorts.htm` (backlist) |
| Author statement on scope | Search summary of the author's blog post "Rip-Off Alert": "The rights granted under my Creative Commons license are strictly noncommercial" and that one "cannot charge money for work that he created and for which you paid nothing". | C | `https://www.rifters.com/crawl/?p=213`, `https://rifters.com/real/2009/01/rip-off-alert.html` |
| Licence text (BY-NC-SA 2.5 Generic) | Legal code section 4(c) obtained from the Creative Commons legal-tools repository: "You may not exercise any of the rights granted to You in Section 3 above in any manner that is primarily intended for or directed toward commercial advantage or private monetary compensation." | B | `https://creativecommons.org/licenses/by-nc-sa/2.5/legalcode` (canonical), read from `https://raw.githubusercontent.com/creativecommons/cc-legal-tools-data/main/docs/licenses/by-nc-sa/2.5/legalcode.en.html` |

Decision: source profile `rifters_reference` v1 is **reference only** in the pilot. Under the commercial intended use, *Blindsight* is `not_eligible` (rule NC) and is never transferred. Under a private noncommercial mode it would be a candidate, and the embedded licence would still have to be read from the file before indexing. The exact licence version is `needs_review` until the page is read; the exclusion decision does not depend on the version.

### 1.4 Selected site `https://oceanofpdf.com/` and background evidence

| Aspect | Observation | Class | Evidence URL |
|---|---|---|---|
| Direct inspection | Blocked; robots.txt and any terms page not read. No crawl was attempted and none is designed. | — | — |
| Authors Guild account | Search summary of the article (published 2024-08-22 per search results): OceanofPDF is "one of the most notorious digital ebook piracy sites"; "the site's operators load the books and other content themselves, with the express goal of distribut[ing] illegal content"; DMCA notices to the site are described as ineffective because the operators upload the content; the Guild notified the hosting provider. | C | `https://authorsguild.org/news/oceanofpdf-piracy-site-actions-authors-can-take/` |
| 2026 status | Third-party reports say the site was offline or intermittent several times in 2026 (March, May, July). Not verified. Failure to access a site is not proof of infringement and is not relied on. | C | `https://screenrant.com/ocean-pdf-free-book-piracy-site-offline/`, `https://en.wikipedia.org/wiki/OceanofPDF` |

Decision: source profile `oceanofpdf` v1 has `approval: unapproved`. There is no verified approval for the site to supply this experiment's ebook files, no item-level permission route was found, and the background evidence indicates the operators upload content without rightsholder authorization. The profile permits exactly one operation: offline parsing of a user-supplied URL into title and author clues for re-resolution against approved sources. No lawful bulk-download route is invented. If a rightsholder-authorized route for a specific item is later documented, it would be a new profile version with its own evidence.

### 1.5 Implementation documentation consulted

| Topic | What was read | Class | Key facts recorded |
|---|---|---|---|
| SQLite FTS5 | `https://sqlite.org/fts5.html` was not fetchable. Behaviour verified empirically on the sandbox's SQLite 3.45.1 through Python 3.11.15 (`evidence/fts5_probe.py`, output in `evidence/fts5_probe_output.txt`). | A (empirical) | `sqlite_compileoption_used('ENABLE_FTS5')` = 1; virtual table creation works; tokenizers `unicode61`, `unicode61 remove_diacritics 2`, `porter unicode61`, `trigram`, `ascii` accepted; external-content table with `content=`/`content_rowid=` and insert/delete/update triggers kept consistent; `MATCH` with prefix (`utilitarian*`), phrase, `NEAR(...)`, column filter (`text: naive`) and diacritic folding (`zurich` matched "Zürich"); `bm25()` ordering (more negative = better), `rank`, `snippet()`, `highlight()`; raw operator words in user input raise `fts5: syntax error`, double-quoted tokens do not; `integrity-check`, `optimize`, `rebuild` commands succeed. The implementer must still read the FTS5 documentation on the target machine and re-run the probe there. |
| pypdf | `docs/user/extract-text.md`, `robustness.md`, `metadata.md` at tag `6.18.1` from `https://github.com/py-pdf/pypdf`; PyPI reports 6.18.1 as latest, `requires_python >= 3.9`. | B | `PdfReader(...).pages[i].extract_text()`; `extraction_mode="layout"` options; visitor functions; memory warning ("we have seen 10 GB RAM being required for an uncompressed content stream of about 300 MB"; check `len(page.get_contents().get_data())` beforehand); "pypdf is **not** OCR software"; scanned pages yield minimal or empty text; `strict=False` is best-effort with warnings. Canonical URL to re-read: `https://pypdf.readthedocs.io/en/stable/user/extract-text.html`. |
| CC BY 4.0 legal code | Section 3(a) from the Creative Commons legal-tools repository (canonical `https://creativecommons.org/licenses/by/4.0/legalcode`). | B | Attribution must retain, if supplied: creator identification and others designated for attribution; a copyright notice; a notice referring to the licence; a notice referring to the disclaimer of warranties; a URI or hyperlink to the material; an indication of modifications; and an indication that the material is licensed under this licence with its text or URI. Conditions may be satisfied "in any reasonable manner based on the medium, means, and context". |
| Copyright term, India | Search summary of India Code, Copyright Act 1957 s.22 to s.24 (page not fetchable). | C | s.22: literary works published in the author's lifetime: copyright until 60 years from the beginning of the calendar year following the year of the author's death; joint works: author who dies last. s.23 anonymous or pseudonymous and s.24 posthumous works: 60 years from the beginning of the calendar year following first publication. Evidence URL: `https://www.indiacode.nic.in/show-data?actid=AC_CEN_9_30_00006_195714_1517807321712&sectionId=14525&sectionno=22&orderno=23`. Not exercised in the pilot (no public-domain items). |
| Python libraries | PyPI JSON: `requests` 2.34.2 (`requires_python >= 3.10`); `ebooklib` 0.20 (AGPL-3.0). | B | `ebooklib` is not used: its licence is a consideration for a possible commercial product and EPUB parsing needs only the standard library. |

## 2. Proposed pilot titles and edition matches (demonstration set)

Label: **demonstration set, chosen by the designer from one eligible publisher; not the user's wishlist.**

| # | Requested identity | Resolved edition (proposed) | Identifier evidence | Licence evidence | Acquire decision (route `obp_thoth` v1) | Use decision (commercial internal index) |
|---|---|---|---|---|---|---|
| D1 | *Ethics for A-Level*, Mark Dimmock and Andrew Fisher | OBP, Cambridge, 2017; DOI `10.11647/OBP.0125`; landing `https://www.openbookpublishers.com/books/10.11647/obp.0125`; PDF `https://books.openbookpublishers.com/10.11647/obp.0125.pdf` | DOI and URLs: class C (search-result URLs). Print ISBN 9781783743896 seen in a bookseller listing (class C); digital ISBNs to be read from Thoth. | Class C: OBP page snippet "This work is licensed under a Creative Commons Attribution 4.0 International license (CC BY 4.0), which allows you to share, copy, distribute and transmit the work; to adapt the work and to make commercial use of the work providing attribution is made to the authors." | `needs_review` → `eligible` automatically when Thoth `license` normalises to CC BY 4.0, robots allows, and host is allowlisted | `needs_review` → `eligible` automatically when the embedded licence statement agrees with Thoth (rule R1) |
| D2 | *Literature Against Criticism: University English and Contemporary Fiction in Conflict*, Martin Paul Eve | OBP, 2016; DOI `10.11647/OBP.0102`; legacy landing `https://www.openbookpublishers.com/product/530`; PDF `https://books.openbookpublishers.com/10.11647/obp.0102.pdf` | Class C (search-result URLs and the author's announcement `https://eve.gd/2016/10/20/my-new-book-literature-against-criticism-is-published-today/`). ISBNs from Thoth. | Class C: search summary "published under CC BY 4.0 ... open access and available to download, read and re-use for free" | as D1 | as D1 |
| D3 | *The Essence of Mathematics Through Elementary Problems*, Alexandre Borovik and Tony Gardiner | OBP, 2019 (publication date reported 2019-06-27); DOI `10.11647/OBP.0168`; landing `https://www.openbookpublishers.com/books/10.11647/obp.0168`; PDF `https://books.openbookpublishers.com/10.11647/obp.0168.pdf`; HTML edition `https://books.openbookpublishers.com/10.11647/obp.0168/` | Class C. Paperback ISBN 978-1-78374-699-6 cited in a Mathematical Gazette review (`https://www.cambridge.org/core/...S0025557221001406a.pdf`); hardback 9781783747009 in a bookseller listing. Digital ISBNs from Thoth. | Class C: OBP page snippet "licensed under a Creative Commons Attribution 4.0 International license (CC BY 4.0) ... to make commercial use of the work providing attribution is made to the author" | as D1 | as D1 |

**Verified count:** 0 of 3 titles verified against a primary source in this sandbox; 3 of 3 have consistent secondary evidence of CC BY 4.0 from the publisher's own pages as indexed by a search engine. The stage-2 preflight is designed to turn each into an automatic `eligible` decision without a per-book confirmation prompt, or to skip and report it.

Backup candidates if any of D1 to D3 fails primary verification (class D, unverified, must be checked the same way): OBP titles listed in OBP's mathematics and philosophy categories with CC BY 4.0, chosen by running the `WorksForPublisher` query and filtering on `license`.

Matching policy for the demonstration set: `exact_edition` on DOI. Any other edition found (for example a second edition with a different DOI) is recorded as a `permitted_alternative` proposal only and is not acquired.

## 3. Exclusion and resolution checks

| Check | Input entry | Resolver behaviour | Expected record |
|---|---|---|---|
| X1 | `{"url": "https://oceanofpdf.com/authors/<author>/pdf-<title>-download/"}` (a synthetic path shape for the fixture; the live check uses whatever URL the user supplies) | Host matches profile `oceanofpdf` (`unapproved`). No request is sent. Slug tokens become `title_clue` and `author_clue`. Re-resolution runs against approved catalogues (`obp_thoth`). | `resolution_status = unapproved_source`; `acquire_decision = not_eligible (rule R6)`; if re-resolution finds no exact match: `unavailable` with reason "no authorized edition found in approved sources"; reported together with other unresolved items |
| X2 | `{"url": "https://www.rifters.com/real/Blindsight.htm"}` | Host matches profile `rifters_reference` (static records, reference only). Identity resolved from the static record (title, author, licence URL, file URLs). | `resolution_status = exact_match`; `use_decision = not_eligible (rule R2, NC)`; `acquire_decision = not_eligible` under commercial settings because the use decision fails before transfer; no bytes transferred |

## 4. Permission decision records (format used in the manifest)

```json
{
  "item_id": "obp-0125",
  "intended_use": "commercial_internal_index",
  "route": {"profile_id": "obp_thoth", "profile_version": 1},
  "licence": {"id": "CC-BY-4.0", "url": "https://creativecommons.org/licenses/by/4.0/", "scope": "whole work; third-party material may be excluded as stated in the work"},
  "evidence": [
    {"kind": "thoth_work_record", "url": "https://api.thoth.pub/graphql", "retrieved_at": null, "sha256": null, "status": "planned"},
    {"kind": "publisher_page_snippet", "url": "https://www.openbookpublishers.com/books/10.11647/obp.0125", "retrieved_at": "2026-09-13", "sha256": null, "class": "C"},
    {"kind": "embedded_licence_statement", "url": null, "retrieved_at": null, "sha256": null, "status": "planned"}
  ],
  "acquire_decision": {"value": "needs_review", "rule": "R1-pending", "reason": "class C evidence only"},
  "use_decision": {"value": "needs_review", "rule": "R1-pending", "reason": "class C evidence only"},
  "scopes": {"download": null, "internal_index": null, "excerpt_display_internal": null, "redistribute_full": false, "share_excerpts_public": false, "train_models": false},
  "attribution_required": true,
  "recorded_at": "2026-09-13"
}
```

The same shape is used for D2 (`obp-0102`), D3 (`obp-0168`), X1 (`unapproved-url-1`, `acquire_decision = not_eligible`, rule R6) and X2 (`rifters-blindsight`, `use_decision = not_eligible`, rule R2).

## 5. Attribution

Template for CC BY 4.0 items (satisfies section 3(a) when the fields are filled from the work record and the file's copyright page):

```
{creators}, "{full_title}" ({publisher}, {year}), {doi_url}.
Licensed under Creative Commons Attribution 4.0 International (CC BY 4.0), https://creativecommons.org/licenses/by/4.0/.
Copyright notice as supplied: "{copyright_notice}".
Modifications: text extracted for internal indexing; no changes to content. Images and any third-party material were not extracted.
Source file: {full_text_url} (SHA-256 {sha256}, retrieved {acquired_at}).
```

`attribution.md` lists one block per indexed book and every retrieval result carries the block's identifier. For any book whose copyright page names third-party material under different terms, the exclusion text is copied verbatim into `third_party_exclusions`.

## 6. Unresolved evidence and the smallest blockers

1. **Primary licence evidence for D1 to D3** (Thoth `license` values and embedded statements). Resolved automatically by the stage-2 preflight; no human action needed unless the sources disagree.
2. **OBP robots.txt and any terms-of-use page.** Fetch once at the start of stage 2; if file paths are disallowed for the pilot's user agent, stop and report.
3. **Thoth terms page text** (`https://thoth.pub/docs/policies/terms-thoth-metadata`). Read once in stage 2 and store; expected to confirm CC0 for metadata. Metadata terms do not affect book-text decisions.
4. **Exact licence wording and version on the *Blindsight* page and inside its files.** Needed only for the record; the exclusion decision holds for any NC variant.
5. **GraphQL enum spellings and the `Doi` scalar's accepted input forms.** Confirm in GraphiQL before finalising the adapter's query strings.
