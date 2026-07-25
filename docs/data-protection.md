# Data protection record

Internal compliance record for the **Jun OS metrics server** — the only part of this
project that processes anyone else's personal data. Not a user-facing document; the
user-facing notice is [`webapp/privacy.html`](../webapp/privacy.html).

Keep this file current. If a supervisory authority ever asks what you do and why,
this is the answer, and having it ready is most of what "cooperating" means in
practice.

| | |
|---|---|
| **Last reviewed** | 2026-07-25 |
| **Notice version in force** | `2026-07-25.2` (`TELEMETRY_NOTICE_VERSION` in `webapp/api/_lib.php`) |

## Scope

Jun OS itself is self-hosted software. A user's account, conversations, memory notes
and preferences live in SQLite on their own machine and are never transmitted. Nothing
in that local processing involves the maintainer, who has no access to it.

This record therefore covers exactly one flow: **chat turns voluntarily shared with the
maintainer-operated metrics server for model training.**

## 1. Controller

| Field | Value |
|---|---|
| Controller | *(maintainer's full name — mirror `webapp/privacy.html`)*, operating `andrealab.it` |
| Privacy contact | `andrea@andrealab.it` |
| Role | Sole controller for shared telemetry. Not a processor for anyone. |
| Art. 27 EU representative | Not required — the controller is established in Italy. |
| DPO | Not required (art. 37): no public authority, no large-scale monitoring, no large-scale art. 9 processing at this scale. Revisit if the opted-in population reaches the thousands. |
| Supervisory authority | Garante per la protezione dei dati personali (Italy) |

Anyone who self-hosts Jun OS for other people is the controller of *their* install,
independently of the maintainer. The README says so.

## 2. Records of processing (art. 30)

The art. 30(5) exemption for organisations under 250 people does **not** apply, because
the processing involves art. 9 data. Hence this record.

| Field | Detail |
|---|---|
| **Purpose** | Training and evaluating the Jun conversational models. No other purpose. No advertising, no sale, no profiling of individuals, no automated decisions about anyone. |
| **Categories of data subject** | Adult users (18+) of Jun OS installs who have explicitly opted in. |
| **Categories of personal data** | Verbatim user-typed messages and model replies; 👍/👎 ratings; the three relationship gauges (affection, trust, tension) before and after each turn, which form part of the prompt the model saw; model name, provider, context size, token counts, timings; a stable random `install_id`; a per-account `user_ref` (truncated `sha256(install_id:user_id)`); a per-conversation tag; a daily-salted hash of the sending IP address. |
| **Special categories (art. 9)** | Yes — data concerning sex life and sexual orientation, inherent in the content of intimate roleplay. Treated as art. 9 data throughout. |
| **Not collected** | Email addresses, passwords, raw IP addresses, real names, the name given to the character, memory notes, journals, wardrobe, and anything predating consent. |
| **Lawful basis** | Art. 6(1)(a) consent; art. 9(2)(a) explicit consent for the special-category element. Consent is the sole basis — no legitimate-interest fallback is claimed. |
| **Recipients** | None. No processors, no analytics vendors, no sub-processors. |
| **Third-country transfers** | None. Server and backups within the EEA. *(If the host ever moves outside the EEA, add the art. 46 safeguard here and to the notice.)* |
| **Retention** | Chat turns 36 months (`RETENTION_DAYS`); IP hashes 30 days (`IP_HASH_RETENTION_DAYS`); both in `metrics-server/db.php`, enforced by `admin-cli.php prune`. |
| **Security measures** | See §5. |

## 3. Consent mechanics (art. 7)

Demonstrability is the point of the design, so the specifics matter:

* Default is **off**. An absent consent row means no; nothing is sent by a fresh or
  upgraded install until someone actively opts in.
* Users are asked once, in-app, by a blocking gate with two equally weighted buttons
  and no pre-selection. Installers do not ask and cannot consent on a user's behalf.
* Each decision is stored per account in the `telemetry_consent` table with a
  server-set timestamp and the notice version in force — the art. 7(1) evidence.
* Withdrawal is one click in Settings → Privacy, no harder than giving consent
  (art. 7(3)), and costs the user no functionality.
* A material change to the notice means bumping `TELEMETRY_NOTICE_VERSION`, which
  invalidates every stored consent and asks everyone again.
* Sharing is never retroactive: only turns sent while consent is live are transmitted.

## 4. Data subject rights (ch. III)

| Right | How it is served |
|---|---|
| Withdraw consent (art. 7(3)) | Settings → Privacy toggle; immediate. |
| Erasure (art. 17) | Settings → Privacy → Request deletion sends `event:"erasure_request"`; the server deletes all rows for that `install_id` + `user_ref`, logs the request and row count in `erasures`, and the next prune vacuums the file. |
| Access, rectification, restriction, portability (art. 15, 16, 18, 20) | By email to the privacy contact, identified by the user's `TELEMETRY_INSTALL_ID`. Answer within one month (art. 12(3)). |
| Object (art. 21) | Not applicable — processing rests on consent, which is withdrawn rather than objected to. |
| Automated decision-making (art. 22) | None carried out. |

**Known limits, stated in the notice rather than hidden:** erasure cannot recover JSONL
exports already taken (re-export after prunes instead of reusing old dumps), and cannot
unlearn model weights already trained. Erasure requests arriving with no valid
`user_ref` are rejected, not widened to a whole install.

## 5. Security (art. 32)

Implemented:

* Ingest is POST-only with a 64 KB body cap, per-IP token-bucket rate limiting, and
  strict payload validation.
* Raw IP addresses are never written — only a daily-salted hash, itself cleared after
  30 days.
* The admin dashboard requires a password plus a confirmed TOTP second factor; sessions
  are cookie-based and only get `Secure` over HTTPS.
* `data/` is gitignored, so no chat content can reach the public repository.
* Prune vacuums the database so deleted content does not persist in freed pages.

**Operator duties that are not code and must not be skipped:**

* TLS in front of the server, always. Never expose the dashboard without it.
* Full-disk or filesystem encryption on the host, and **encrypted backups**. A corpus of
  intimate chats is the one asset here whose leak would genuinely harm people.
* Restrict the admin surface to known addresses where practical.
* Keep exports off general-purpose machines; treat a JSONL dump as the same category of
  data as the database.

## 6. DPIA screening (art. 35)

**Conclusion: no DPIA required at current scale. Documented rather than assumed.**

Art. 35(3)(b) triggers on processing special-category data *on a large scale*. Assessed
against the EDPB criteria — number of data subjects, volume of data, duration,
geographic extent — a fan project with an opted-in population in the dozens to low
hundreds is not large-scale processing. Weighing against a DPIA: consent is explicit and
freely given, there is no profiling or automated decision-making, no vulnerable-group
targeting (18+ only), no data matching or combining across sources, and no innovative
technology applied to the subjects themselves.

**Re-run this screening if any of the following happens:** the opted-in population
reaches roughly a thousand accounts; the data is used for a purpose other than training
Jun; any recipient other than the maintainer is introduced; or profiling of individual
users begins. Record the date and outcome of each re-screening here.

## 7. Breach procedure (art. 33, 34)

Decide this now, because the clock is 72 hours and it starts on awareness, not on
diagnosis.

1. Contain: take the ingest endpoint and dashboard offline. Availability is the least
   important property here.
2. Assess scope: which rows, which time range, whether chat text was included. The
   `erasures` and `events` tables establish what existed when.
3. **Notify the Garante within 72 hours** of becoming aware, unless the breach is
   unlikely to result in a risk. A leak of chat content is *not* in that category —
   assume it is notifiable.
4. Art. 34 individual notification is expected for high-risk breaches, but the design
   deliberately holds no contact details, so it cannot be done directly. Use a public
   communication instead: a prominent notice in the app, the repository and the release
   channel, which art. 34(3)(c) permits where individual contact is disproportionate or
   impossible.
5. Record the facts, effects and remedial action taken — required for every breach even
   when not notified.

## 8. Minors

The app is 18+ and gated by a self-declaration, which is not verification. Some
under-18 use is realistically possible, and consent below the Italian digital-consent
age of 14 would be invalid regardless of what was clicked. Delete any data on becoming
aware that it came from a minor, without waiting for a request.
