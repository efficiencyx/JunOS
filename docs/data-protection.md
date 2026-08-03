# Data protection record

Internal compliance record for the **Jun OS metrics server** — the only part of this
project that processes anyone else's personal data. Not a user-facing document; the
user-facing notice is [`webapp/privacy.html`](../webapp/privacy.html).

Keep this file current. If a supervisory authority ever asks what you do and why,
this is the answer, and having it ready is most of what "cooperating" means in
practice.

| | |
|---|---|
| **Last reviewed** | 2026-07-29 |
| **Notice version in force** | `2026-07-29.1` (`TELEMETRY_NOTICE_VERSION` in `webapp/api/_lib.php`) |

## Scope

Jun OS itself is self-hosted software. A user's account, conversations, memory notes
and preferences live in SQLite on their own machine and are never transmitted. Nothing
in that local processing involves the maintainer, who has no access to it.

This record therefore covers exactly one flow: **chat turns voluntarily shared with the
maintainer-operated metrics server for model training.**

## 1. Controller

| Field | Value |
|---|---|
| Controller | Andrea Torelli, operating `andrealab.it`, Italy |
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
| **Purpose** | Preparing and reviewing a corpus, evaluating Jun responses, training Jun LoRA adapters and potentially publishing adapters that pass the documented anonymity and memorisation assessment. No advertising, sale or profiling of individuals. |
| **Categories of data subject** | Adult users (18+) of private Jun OS installs who have explicitly opted in; people whom those users may identify in free-text chats despite being told not to. |
| **Categories of personal data** | Up to the first 8,192 bytes of verbatim user text and raw model output. The raw output is captured before hidden action, relationship and `memory_write` tags are removed from the visible reply. Also: 👍/👎 ratings; the three relationship gauges (affection, trust, tension) before and after each turn; model name, provider, context size, token counts, timings, reasoning setting, request route and idle-state flag; a stable random `install_id`; a per-account `user_ref` (truncated `sha256(install_id:user_id)`); conversation and turn tags; timestamps; schema, event and notice-version fields; connection IP addresses and request metadata processed by Cloudflare and the origin; a daily-salted IP hash retained by the origin. |
| **Special categories (art. 9)** | Yes — data concerning sex life and sexual orientation, inherent in the content of intimate roleplay. Treated as art. 9 data throughout. |
| **Not collected as payload fields** | Account email addresses, passwords, real names, the name given to the character, existing saved memory notes, journals and wardrobe. Any of these may still appear if a user types them into shared chat text. A proposed memory may also appear in a hidden `memory_write` tag in the raw model output. Conversation text predating consent is not uploaded retroactively. |
| **Lawful basis** | For the consenting user's submitted data: art. 6(1)(a) consent and art. 9(2)(a) explicit consent for special-category data. No legitimate-interest fallback is claimed. A user's consent cannot authorise processing of another person's data; third-party data is prohibited and remains an unresolved risk requiring controls in the DPIA. |
| **Recipients** | Cloudflare, Inc., relevant Cloudflare group companies and subprocessors used to deliver and protect the endpoint. Cloudflare acts as processor for content and customer logs and describes itself as controller for certain network data it creates. No advertising or third-party analytics recipients. |
| **Third-country transfers** | The origin and backups are in Italy. Cloudflare operates a global network and may process data in the United States and other countries. EEA-to-US transfers rely on Cloudflare's EU–US Data Privacy Framework certification, with the European Commission's Standard Contractual Clauses and supplementary measures as fallback under Cloudflare's DPA. |
| **Retention** | Chat turns 36 months (`RETENTION_DAYS`); origin IP hashes 30 days (`IP_HASH_RETENTION_DAYS`); encrypted backup copies no more than 30 days. Official public adapter downloads remain until six months after a tested successor supersedes them; independent copies may persist. |
| **Security measures** | See §5. |

## 3. Consent mechanics (art. 7)

Demonstrability is the point of the design, so the specifics matter:

* Default is **off**. An absent consent row means no; nothing is sent by a fresh or
  upgraded install until someone actively opts in.
* Users are asked once, in-app, by a blocking gate with two equally weighted buttons
  and no pre-selection. Installers do not ask and cannot consent on a user's behalf.
* Each decision is stored per account in the `telemetry_consent` table with a
  server-set timestamp and the notice version in force — the art. 7(1) evidence.
  This record is held by the private install, not by the central controller, and is
  therefore an unresolved demonstrability risk.
* Withdrawal is one click in Settings → Privacy, no harder than giving consent
  (art. 7(3)), and costs the user no functionality.
* A material change to the notice means bumping `TELEMETRY_NOTICE_VERSION`, which
  invalidates every stored consent and asks everyone again.
* Sharing is never retroactive: only turns sent while consent is live are transmitted.

## 4. Data subject rights (ch. III)

| Right | How it is served |
|---|---|
| Withdraw consent (art. 7(3)) | Settings → Privacy toggle; immediate. |
| Erasure (art. 17) | Settings → Privacy → Request deletion records withdrawal locally and attempts to send `event:"erasure_request"` for the `install_id` + `user_ref`. The current client status proves initiation, not collector completion. Email follow-up is available for confirmation. |
| Access, rectification, restriction, portability (art. 15, 16, 18, 20) | By email to the privacy contact, identified by both `TELEMETRY_INSTALL_ID` and the account-specific `user_ref`. Answer within one month (art. 12(3)). |
| Object (art. 21) | Not applicable — processing rests on consent, which is withdrawn rather than objected to. |
| Automated decision-making (art. 22) | None carried out. |

**Known limits, stated in the notice rather than hidden:** the app does not currently
receive a deletion-completion acknowledgement, and a normal account cannot display its
own `user_ref`. Erasure must propagate to corpus exports and to any restored backup
before it returns to use. Erasure requests arriving with no valid `user_ref` are rejected,
not widened to a whole install.

A trained adapter is not assumed to be anonymous. It may be published only after a
documented assessment concludes that direct or indirect identification and extraction of
personal training data are very unlikely. An adapter that fails is scrapped or retrained.

## 5. Security (art. 32)

Implemented:

* Ingest is POST-only with a 64 KB body cap, per-IP token-bucket rate limiting, and
  strict payload validation.
* The origin does not persist raw IP addresses — only a daily-salted hash, itself
  cleared after 30 days. Cloudflare separately processes connection IP addresses and
  request metadata under its DPA.
* The admin dashboard requires a password plus a confirmed TOTP second factor; sessions
  are cookie-based and only get `Secure` over HTTPS.
* `data/` is gitignored, so no chat content can reach the public repository.
* Prune vacuums the database so deleted content does not persist in freed pages.
* The origin VM and its backup copies reside on an encrypted hypervisor storage layer in
  Italy. Backups expire within 30 days.
* Cloudflare's DPA version 6.4, effective 2026-04-03, incorporates the EU SCCs and its
  transfer provisions. Keep evidence that the DPA applies to the account and review
  Cloudflare's subprocessor changes.

**Operator duties that are not code and must not be skipped:**

* TLS in front of the server, always. Never expose the dashboard without it.
* Keep hypervisor encryption enabled and protect its keys separately from credentials
  that can read the running VM. A corpus of intimate chats is the one asset here whose
  leak would genuinely harm people.
* Restrict the admin surface to known addresses where practical.
* Keep exports off general-purpose machines; treat a JSONL dump as the same category of
  data as the database.

## 6. DPIA status (art. 35)

**Conclusion: a DPIA is required and remains pending.**

The Italian Garante's art. 35(4) list requires a DPIA where innovative technology,
including artificial intelligence, is combined with another EDPB high-risk criterion.
This processing combines AI development with sensitive and highly personal sexual chat
data. Small scale does not remove that combination. The Garante's 3 July 2026 Character
AI decision confirms that undocumented internal risk reviews are not a substitute for a
formal DPIA.

The DPIA must cover collection, Cloudflare transfers, corpus review and exports,
third-party data, consent evidence, rights handling, backup restoration, age
self-declaration, LoRA training, privacy testing and public distribution. Operating the
collector while this remains pending is a recorded compliance risk and must not be
described as GDPR-compliant.

## 7. Public adapter release control

Before any adapter trained on shared chats is published:

1. Record its exact source-corpus snapshot and every erasure applied before training.
2. Test for rare-string memorisation, prompt-based extraction and direct or indirect
   identification, comparing the adapter with its unmodified base model.
3. Publish only if extraction and identification are documented as very unlikely.
4. Scrap or retrain every failing adapter; disclosure alone is not a substitute.
5. Remove the official download six months after a tested successor supersedes it.
   Record that independent copies may persist and retain the assessment and lineage.

## 8. Unresolved risks

* The controller cannot independently demonstrate consent because the authoritative
  record remains on each private installation.
* The erasure call has no end-to-end acknowledgement or completion-status check.
* Users cannot read their own `user_ref` through the app, impairing email-based rights.
* Free-text chat can contain personal and special-category data about non-consenting
  third parties; the notice and prohibition do not replace technical and review controls.
* The 18+ gate is a self-declaration, not verified age assurance.
* The formal DPIA and its residual-risk decision are not complete.

## 9. Breach procedure (art. 33, 34)

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

## 10. Minors

The app is 18+ and gated by a self-declaration, which is not verification or age
assurance. Some under-18 use is realistically possible. Consent to this adult-data
processing must not be accepted from a minor; delete any data on becoming aware that it
came from one, without waiting for a request.

## References

* [GDPR, including arts. 13–17, 30, 32 and 35](https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX%3A32016R0679)
* [EDPB Opinion 28/2024 on personal data in AI models](https://www.edpb.europa.eu/documents/opinion-of-the-board-art-64/opinion-282024-on-certain-data-protection-aspects-related-to_en)
* [Italian Garante art. 35(4) DPIA list](https://www.garanteprivacy.it/documents/10160/0/ALLEGATO%2B1%2BElenco%2Bdelle%2Btipologie%2Bdi%2Btrattamenti%2Bsoggetti%2Bal%2Bmeccanismo%2Bdi%2Bcoerenza%2Bda%2Bsottoporre%2Ba%2Bvalutazione%2Bdi%2Bimpatto)
* [Italian Garante decision of 3 July 2026 concerning Character AI](https://www.garanteprivacy.it/web/guest/home/docweb/-/docweb-display/docweb/10269571)
* [Cloudflare Customer DPA](https://www.cloudflare.com/en-gb/cloudflare-customer-dpa/)
