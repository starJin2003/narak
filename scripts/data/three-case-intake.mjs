// Fixed bibliographic intake, not a crawler or a runtime model input archive.
// Catalog titles and notes are original paraphrases; no publisher excerpts.
export const discoveredAt = "2026-11-03T19:28:36.670Z";

export const sources = [
  {
    key: "mt-tank-day", canonical_url: "https://www.mt.co.kr/living/2026/05/18/2026051814054774713",
    title: "Catalog: Starbucks withdraws Tank Day promotion after criticism", publisher: "MoneyToday",
    published_on: "2026-05-18", available_at: "2026-05-18T05:38:00Z",
    provenance_note: "Accessible publisher article inspected on 2026-11-03; byline Lee Byeong-gwon; published May 18, 2026 at 14:38 KST. Reporting of promotion wording, online criticism and company response; original campaign assets not independently inspected. Robots allows article search/user access; footer prohibits unauthorized reproduction and AI training. Store bibliographic metadata and brief original attributed factual notes only, no article text, excerpts, assets, training dataset or Meta submission. No license or human rights approval asserted.",
  },
  {
    key: "chosun-tank-investigation", canonical_url: "https://biz.chosun.com/distribution/channel/2026/05/26/C6WSJCO5NBHS5DY5KIS3DL36C4/",
    title: "Catalog: Shinsegae reports Tank Day investigation and approval failures", publisher: "ChosunBiz",
    published_on: "2026-05-26", available_at: "2026-05-26T07:58:00Z",
    provenance_note: "Accessible publisher article inspected on 2026-11-03; byline Jeong Jae-hwon. First published May 26, 2026 at 10:27 KST, updated 16:58 KST; observed_at conservatively uses update time. Reports company investigation briefing, not an independent determination of intent. Publisher robots permits search/citation and AI user input with attribution/link, prohibits training and copied archives. Metadata and original brief notes only; no copied content or rights approval.",
  },
  {
    key: "inven-nexon-response", canonical_url: "https://www.inven.co.kr/webzine/news/?news=290842",
    title: "Catalog: Nexon responds to Angelic Buster animation controversy", publisher: "Inven",
    published_on: "2023-11-26", available_at: "2023-11-26T10:47:00Z",
    provenance_note: "Accessible publisher article inspected on 2026-11-03; byline Yang Ye-chan; November 26, 2023 at 19:47 KST. Reports director livestream and Nexon response; this is company attribution, not independent proof of disputed symbolism or personal responsibility. Robots permits this article path; copyright restricts reproduction. Bibliographic metadata and brief original factual notes only, no excerpts, frames or copied article; no rights approval.",
  },
  {
    key: "inews-production-correction", canonical_url: "https://www.inews24.com/view/1660539",
    title: "Catalog: Reporting contradicts attribution of disputed animation frame", publisher: "iNews24",
    published_on: "2023-11-30", available_at: "2023-11-30T10:37:49Z",
    provenance_note: "Accessible publisher article inspected on 2026-11-03; byline Kim Da-un; November 30, 2023 at 19:37:49 KST. Publisher canonical http URL normalized to its accessible HTTPS equivalent. SECONDARY reporting explicitly crediting Kyunghyang's November 30 investigation, not independent corroboration; original production records and inaccessible Kyunghyang article not inspected. Robots permits view paths; copyright restricts reproduction. Metadata and short original attributed notes only, no excerpts or frames; no rights approval.",
  },
  {
    key: "edaily-gs25-response", canonical_url: "https://www.edaily.co.kr/News/Read?mediaCodeNo=257&newsId=02148406629044984",
    title: "Catalog: GS25 withdraws camping poster and explains production", publisher: "Edaily",
    published_on: "2021-05-02", available_at: "2021-05-02T07:17:24Z",
    provenance_note: "Accessible publisher article inspected on 2026-11-03; byline Ham Ji-hyeon; published/modified May 2, 2021 at 16:17:24 KST. Reports poster elements, contested readings, customer reactions and GS25 explanation; original poster and asset licenses not independently examined. Robots permits user search/article access; copyright restricts reproduction. Metadata and brief original attributed factual notes only, no excerpts or creative assets; no rights approval.",
  },
  {
    key: "newspim-designer-account", canonical_url: "https://www.newspim.com/news/view/20210510000585",
    title: "Catalog: Anonymous account offers GS25 poster production explanation", publisher: "NewsPim",
    published_on: "2021-05-10", available_at: "2021-05-10T03:21:58Z",
    provenance_note: "Accessible publisher article inspected on 2026-11-03; byline Nam Ra-da; May 10, 2021 at 12:21:53 KST, updated 12:21:58 KST (conservative observed_at). Repeats a May 9 anonymous Blind account claiming to be the designer; identity and production files not independently verified. Robots permits news path; copyright restricts reproduction. Metadata and brief original attributed notes only, no excerpts or assets; no rights approval.",
  },
];

export const cases = [
  {
    case_key: "starbucks-kr-tank-day-2026-05-18", title: "Starbucks Korea Tank Day promotion, May 2026",
    context_summary: "Emerging source registry entry for promotion wording and historical-date associations. Distinguish reported criticism, company response and later internal investigation. No finding of deliberate mockery; source reports and original creative have not undergone human verification.",
    event_start_date: "2026-05-18",
    evidence: [
      { key: "promotion-wording", source: "mt-tank-day", kind: "reported_fact", text: "MoneyToday reports a May 18 Tank Day tumbler promotion with desk-tapping copy, within a wider Buddy Week campaign.", attribution: "MoneyToday reporting of Starbucks promotion" },
      { key: "historical-reading", source: "mt-tank-day", kind: "reported_interpretation", text: "MoneyToday reports critics associating the date and tank wording with the Gwangju crackdown, and the desk-slap wording with the 1987 Park Jong-chul police statement. These are attributed readings, not established intent.", attribution: "Online critics as reported by MoneyToday" },
      { key: "withdrawal-response", source: "mt-tank-day", kind: "reported_fact", text: "MoneyToday reports Starbucks apologizing on May 18, stopping the promotion and removing related pages and posts.", attribution: "Starbucks response reported by MoneyToday" },
      { key: "approval-investigation", source: "chosun-tank-investigation", kind: "reported_fact", text: "ChosunBiz reports Shinsegae's May 26 briefing describing four approval stages that missed the date association, including approvers who did not open an attachment.", attribution: "Shinsegae internal investigation briefing reported by ChosunBiz" },
      { key: "intent-not-established", source: "chosun-tank-investigation", kind: "rebuttal", text: "ChosunBiz reports the company found no clear evidence establishing deliberate disparagement; employees described rhyme and desk use as the rationale. This limited internal account does not independently establish individual intent.", attribution: "Company and employee explanations reported by ChosunBiz" },
    ],
    triggers: [
      { key: "copy-context", evidence: "promotion-wording", kind: "copy", match: "Tank Day; \ucc45\uc0c1 \uc704\uc5d0 \ud0c1", description: "Wording can warrant date-sensitive source review when paired with this promotion context; isolated words do not establish a concern." },
      { key: "creative-context", evidence: "promotion-wording", kind: "imagery", match: "tumbler promotion accompanying Tank Day copy", description: "Review a product/desk creative together with its wording and date. The product image alone has no established disputed meaning; no original asset was inspected." },
      { key: "date-context", evidence: "historical-reading", kind: "publication_date", start: "2026-05-18", end: "2026-05-18", description: "Historical campaign-date context only. This case was registered retrospectively; later May 26 reporting is unavailable to an earlier as-of review." },
    ],
  },
  {
    case_key: "maplestory-angelic-buster-frame-2023-11", title: "MapleStory Angelic Buster static-frame controversy, November 2023",
    context_summary: "Emerging record limited to a reported static animation frame and its disputed attribution. November 26 is the accepted company-response anchor, not a confirmed original upload date. Later secondary reporting contradicts attribution to a targeted employee. No full-video analysis or inference about personal intent, identity or ideology.",
    event_start_date: "2023-11-26",
    evidence: [
      { key: "nexon-response", source: "inven-nexon-response", kind: "reported_fact", text: "Inven reports Nexon's director saying Angelic Buster promotional videos were removed and studio-related material was being reviewed following the controversy. Company action is not proof of the allegation.", attribution: "Nexon director livestream reported by Inven" },
      { key: "attribution-allegation", source: "inews-production-correction", kind: "reported_interpretation", text: "iNews24 retrospectively describes an allegation assigning a disputed hand frame to a targeted female animator. The allegation and symbolic interpretation remain attributed claims, not verified responsibility.", attribution: "Allegation recounted by iNews24; retrospective report" },
      { key: "attribution-correction", source: "inews-production-correction", kind: "correction", related: "attribution-allegation", text: "iNews24, crediting Kyunghyang, reports the storyboard came from a different company's animator and the targeted employee handled other cuts, contradicting the initial attribution. This is secondary reporting; original records were not independently examined.", attribution: "iNews24 repeating Kyunghyang's production investigation" },
      { key: "production-context", source: "inews-production-correction", kind: "rebuttal", text: "The same secondary report describes a heart-motion storyboard and multiple production/client reviews. This supplies an alternative production account, not proof of any person's intentions.", attribution: "Production account reported by iNews24 with credit to Kyunghyang" },
    ],
    triggers: [
      { key: "copy-context", evidence: "nexon-response", kind: "copy", match: "Angelic Buster; \uc5d4\uc824\ub9ad\ubc84\uc2a4\ud130", description: "Title wording identifies the relevant production context; it is not itself disputed or a blacklist term." },
      { key: "frame-context", evidence: "production-context", kind: "imagery", match: "thumb and index finger near one another in a static animation frame", description: "A superficially similar frame requires pose/production context and the later attribution correction. Similarity cannot establish intent, gender motivation or ideology; no video capability is asserted." },
      { key: "date-context", evidence: "nexon-response", kind: "publication_date", start: "2023-11-26", end: "2023-11-30", description: "Reported response and later correction occupy different dates. A November 26 as-of review cannot use November 30 correction or production reporting." },
    ],
  },
  {
    case_key: "gs25-camping-poster-2021-05", title: "GS25 camping promotion poster, May 2021",
    context_summary: "Emerging registry entry separating reported poster elements from disputed symbolic readings, company responses and an anonymous production explanation. May 2 is the first accepted report/response anchor, not a confirmed first-post date. Customer reactions are reported anecdotes, not a measured population response or proof of intent.",
    event_start_date: "2021-05-02",
    evidence: [
      { key: "reported-poster-elements", source: "edaily-gs25-response", kind: "reported_fact", text: "Edaily describes a camping promotion poster with a hand illustration and English camping copy, and moon/star elements in a revision. These are reported descriptions; the original assets were not inspected.", attribution: "Poster descriptions reported by Edaily" },
      { key: "symbolism-allegations", source: "edaily-gs25-response", kind: "reported_interpretation", text: "Edaily reports critics interpreting the hand, reversed word endings and revised celestial elements as community references. These contested symbolic readings are not objective properties or proof of deliberate signaling.", attribution: "Critics' readings reported by Edaily" },
      { key: "company-explanation", source: "edaily-gs25-response", kind: "rebuttal", text: "Edaily reports GS25 apologizing, changing and withdrawing the poster; the company attributed the English wording to portal translation and imagery to paid camping stock assets. Asset rights and production records were not independently checked.", attribution: "GS25 response and production explanation reported by Edaily" },
      { key: "reported-reactions", source: "edaily-gs25-response", kind: "reported_fact", text: "Edaily describes customer objections, boycott discussion and disagreement. The reporting does not establish representative sentiment or quantified business impact.", attribution: "Customer reactions reported by Edaily" },
      { key: "anonymous-production-account", source: "newspim-designer-account", kind: "rebuttal", text: "NewsPim repeats a May 9 anonymous Blind account claiming to be the designer: hand/sky details came from stock assets, wording from a planner, and symbolism was unintended. The speaker's identity and account are unverified; this is not independent production confirmation.", attribution: "Anonymous self-described designer quoted in NewsPim reporting" },
    ],
    triggers: [
      { key: "copy-context", evidence: "symbolism-allegations", kind: "copy", match: "Emotional Camping Must-have Item", description: "Review the phrase in the specific poster/revision context; reported letter-based interpretations remain disputed and should not become a general word ban." },
      { key: "poster-context", evidence: "reported-poster-elements", kind: "imagery", match: "camping poster with hand near food; moon and stars in revisions", description: "Composition and revision history matter. Generic hand, tent, food or sky imagery alone cannot establish the alleged symbolism; retain company and anonymous production explanations." },
      { key: "date-context", evidence: "reported-poster-elements", kind: "publication_date", start: "2021-05-02", end: "2021-05-10", description: "Separate the May 2 company-response report from the later May 10 anonymous-account report. Later explanations cannot be used as earlier available evidence." },
    ],
  },
];
