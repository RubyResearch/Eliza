/**
 * Detectors for replies that assert ungrounded state: an already-completed
 * scheduling/save side effect ("I've set…", "Done — your reminders are set")
 * and the read-side twin — an empty/absent tracked-work state ("your task
 * list is empty", "I don't have today's log"). Lives in a leaf module because
 * the Stage-1 response-handler evaluators (services/message.ts), the
 * planner-path REPLY action guard (features/basic-capabilities/actions/
 * reply.ts), and the planned-reply egress guard all consume it — importing
 * the full message service from an action would create an import cycle.
 *
 * Detection is split by grammatical certainty so that only ASSERTIONS
 * fire; consent-seeking offers, questions, and conditionals must pass
 * through untouched (a rewritten offer forces an unwanted planner run — the
 * user asked a question and got an action).
 *
 * Coverage is tiered by locale: the English shapes below, plus per-locale
 * claim tiers for the shipped keyword locales (es, ko, pt, tl, vi, zh-CN).
 * Each locale tier gates on that locale's tracked-work nouns inside the
 * containing sentence, matches only perfective/completed verb shapes, and
 * excludes negation/subordination leads, second-person descriptions, and
 * question sentences — including full-width terminators and particle-final
 * questions (吗/吧/呢, -까요, …không) that carry no question mark. None of
 * these patterns use `\b`, which is ASCII-only and silently dead against
 * letters like the Vietnamese "nhắc nhở" — boundaries are Unicode
 * lookarounds instead (#17027 AC7).
 */

// Perfective first-person claims ("I've set…", "I have scheduled…", "I just
// added…") carry an explicit completion auxiliary, so they read as reports in
// any sentence shape — including tag questions ("I've set it — anything
// else?"). Only a leading subordinator ("Once I've set…") turns one into a
// plan instead of a report. Adjacency keeps denials out: "I have not set"
// never matches.
const PERFECTIVE_SIDE_EFFECT_CLAIM_PATTERN =
	/\bi(?:['’]ve|\s+have|\s+just)\s+(?:(?:just|already|now)\s+)?(?:set|scheduled|created|added|saved|booked|logged|arranged|updated|renamed|deleted|removed|cancell?ed)\b/gi;
// Bare simple-past claims ("I set a reminder for 9am."). "set" is the one
// verb here whose past tense equals its base form, so offers ("Should I
// set…?", "Before I set…") collide with reports on the raw pattern — this
// branch is additionally gated on the word preceding "I" and on the
// containing sentence not being a question.
const BARE_PAST_SIDE_EFFECT_CLAIM_PATTERN =
	/\bi\s+(?:set|scheduled|created|added|saved|booked|logged|arranged|updated|renamed|deleted|removed|cancell?ed)\b/gi;
// State-of-the-world completion claims that need no first-person subject
// ("that's all set", "your reminders are set", "is now set up", "Done —").
// The "now" forms and the bare completion opener ("Saved!", "Done.") were
// added after a live fabricated reply — "Saved! ✅ Your book report plan is
// now set up as reminders" with zero tool calls — slipped through the
// first-person-only shapes (#16941). The bare "done —" branch is anchored to
// the start of the (trimmed) reply or of a sentence, so congratulations like
// "Well done — that's every task cleared." are not misread (#16987).
const STATE_SIDE_EFFECT_CLAIM_PATTERN =
	/\b(?:(?:it['’]s|it is|you['’]re|that['’]s)\s+all\s+set\b|remind(?:er)?s?\s+(?:are|is)\s+(?:set|saved|scheduled|in\s+place)\b|(?:is|are)\s+now\s+(?:set(?:\s+up)?|saved|scheduled|in\s+place)\b)|(?:^|[.!?]\s+)done\s*[—–-]|^\s*(?:saved|done)\s*[!.…✅🎉]/giu;
// A modal, interrogative auxiliary, or subordinator immediately before the
// matched "I" makes the clause an offer/question/condition ("Should I
// set…?", "Shall I set…?", "When I set…", "Once I've set…"), not a report of
// finished work.
const NON_ASSERTIVE_SIDE_EFFECT_LEAD_PATTERN =
	/\b(?:should|shall|can|could|may|might|would|will|do|does|did|must|if|unless|once|when|whenever|while|before|after|until|whether)\s+$/i;
// The claim must be ABOUT a schedulable/saved thing, not e.g. "I've set aside
// some thoughts". Vocabulary mirrors the scheduled-item nouns the LifeOps
// surfaces own.
const SIDE_EFFECT_SUBJECT_NOUN_PATTERN =
	/\b(?:remind(?:er)?s?|alarms?|schedul(?:e|ed|ing)|scheduled\s+(?:task|item)s?|tasks?|appointments?|calendar|routines?|habits?|goals?|todos?|to[- ]dos?|notes?|check[- ]?ins?|follow[- ]?ups?|set[- ]?up|setup|onboard(?:ing)?|first[- ]?run|settings|defaults|configur(?:ation|ed))\b/i;

function sentenceContaining(text: string, index: number): string {
	let start = index;
	while (start > 0 && !/[.!?\n]/u.test(text[start - 1] ?? "")) {
		start -= 1;
	}
	let end = index;
	while (end < text.length && !/[.!?\n]/u.test(text[end] ?? "")) {
		end += 1;
	}
	return text.slice(start, end);
}

// A generic "done" sentence is exempt only when its complete grammar is a
// read/navigation acknowledgement. Keeping this full-sentence match narrow is
// important: a loose "contains a read verb and no known write verb" test lets
// an unlisted mutation hide beside the read (for example, "notes are visible
// and I archived the old ones").
const READ_NAVIGATION_ONLY_SENTENCE_PATTERN = new RegExp(
	String.raw`^[\s.!?…–—-]*done\b[\s:;,…–—-]*(?:` +
		String.raw`(?:showing|displaying|loading|opening|rendering|highlighting|pulled\s+up|brought\s+up)\s+` +
		String.raw`(?:the\s+|your\s+)?(?:\d+\s+)?(?:notes?|reminders?|tasks?|todos?|to[- ]dos?|goals?|habits?|appointments?|calendar|settings)(?:\s+view)?` +
		"|" +
		String.raw`(?:the\s+|your\s+)?(?:\d+\s+)?(?:notes?|reminders?|tasks?|todos?|to[- ]dos?|goals?|habits?|appointments?|calendar|settings)(?:\s+view)?\s+` +
		String.raw`(?:is|are)\s+(?:now\s+)?(?:loaded|visible|shown|displayed|open|rendered|onscreen|on\s+screen|in\s+view|pulled\s+up|brought\s+up|highlighted)` +
		"|" +
		// "done — you're on Settings." is the deterministic view-navigation
		// confirmation the runtime synthesizes from an accepted
		// view_navigation effect receipt; when the destination view's label
		// collides with a tracked-work noun (Settings, Notes, Calendar) the
		// sentence must still read as navigation, not as a committed mutation.
		String.raw`(?:you['’]re|you\s+are)\s+(?:now\s+)?(?:back\s+)?(?:on|in|at)\s+` +
		String.raw`(?:the\s+|your\s+)?(?:notes?|reminders?|tasks?|todos?|to[- ]dos?|goals?|habits?|appointments?|calendar|settings)(?:\s+view)?(?:\s+now)?` +
		String.raw`)[\s…✅🎉]*$`,
	"iu",
);
// A bare completion opener ("Done —", "Done!", "Done.") carries no verb of its
// own — only the rest of its sentence can. Match text that begins with "done"
// (after the leading sentence-boundary anchor the STATE pattern captures)
// identifies these generic openers so they are held to the read-verb exclusion
// below.
const GENERIC_COMPLETION_OPENER_PATTERN = /^[\s.!?…–—-]*done\b/i;

/**
 * Bare completion openers must name their tracked subject in the same
 * sentence. A later question such as "Done. What should we do with your
 * notes?" mentions notes but does not claim a note was saved; treating the
 * whole reply as one clause replaces a true UI-navigation acknowledgement
 * with the unrelated unverified-effect fallback.
 *
 * A generic "done" opener is additionally rejected when its sentence's only
 * predicate is a read/navigation verb: "Done — your notes are loaded/visible"
 * (and the quantified variants) surfaced tracked state rather than committing a
 * write, so it is not a mutation report (#22609). A committed-mutation verb in
 * the same sentence overrides that exclusion, and openers whose own match text
 * carries the write verb ("reminders are set", "Saved!") are unaffected.
 */
function stateSideEffectClaimHasLocalSubject(text: string): boolean {
	for (const match of text.matchAll(STATE_SIDE_EFFECT_CLAIM_PATTERN)) {
		const firstWordOffset = match[0].search(/[\p{L}\p{N}]/u);
		const claimIndex =
			(match.index ?? 0) + (firstWordOffset >= 0 ? firstWordOffset : 0);
		const sentence = sentenceContaining(text, claimIndex);
		if (!SIDE_EFFECT_SUBJECT_NOUN_PATTERN.test(sentence)) continue;
		if (
			GENERIC_COMPLETION_OPENER_PATTERN.test(match[0]) &&
			READ_NAVIGATION_ONLY_SENTENCE_PATTERN.test(sentence)
		) {
			continue;
		}
		return true;
	}
	return false;
}

// True when the sentence containing the match (scanning forward from the
// match) terminates in "?" — the shape of a consent-seeking offer or a
// clarifying question ("I set reminders in the morning usually — should I?").
function sideEffectClaimSentenceIsQuestion(
	text: string,
	fromIndex: number,
): boolean {
	for (let i = fromIndex; i < text.length; i += 1) {
		const ch = text[i];
		if (ch === "?") return true;
		if (ch === "." || ch === "!" || ch === "\n") return false;
	}
	return false;
}

/**
 * True when a reply ASSERTS that a scheduling/save side effect already
 * happened. When no tool has run in the turn any such assertion is
 * fabricated — the "not loaded must never read as zero" doctrine applied to
 * writes: "no tool ran" must never read as "done" (#16935; observed live: a
 * bill-reminder ask answered "Done — I've set two reminders" with zero tool
 * calls, plus invented "session-only" caveats). Consent-seeking offers,
 * questions, and conditionals ("Want me to set…?", "Should I set…?", "I could
 * set…") are NOT claims and must return false — rewriting them to "On it."
 * turns a question the user asked into an action they did not consent to.
 */
// Subjectless past-participle openers — "Added todo: sand the shelf",
// "saved a note: the charger is in the drawer", "Deleted the reminder." The
// live fabrication shape the I-subject patterns miss: the model reports
// finished work headline-style with no pronoun (observed on the Discord
// group surface: "Added todo: sand the dc5 shelf (no deadline, general
// task)" shipped with ZERO tool calls). Anchored to a sentence start so
// ordinary mid-sentence past tense ("the note I added yesterday") passes;
// bare "set" is deliberately absent — "Set a reminder on your phone…" is a
// common advisory imperative, not a report.
const SUBJECTLESS_PAST_SIDE_EFFECT_CLAIM_PATTERN =
	/(?:^|[.!?]\s+)(?:added|created|saved|scheduled|booked|logged|deleted|removed|renamed|cancell?ed|arranged)\b/gi;

// Noun-first passive headline claims — "todo added: polish the lens",
// "note saved.", "reminder set: 9am" (live variant that evaded the verb-first
// shape above: the model leads with the record noun). Requires the terminal
// claim punctuation/colon so descriptive prose ("the todo added by you last
// week…") passes through.
const NOUN_FIRST_SIDE_EFFECT_CLAIM_PATTERN =
	/(?:^|[.!?]\s+)(?:todos?|to[- ]dos?|notes?|reminders?|alarms?|tasks?|events?|appointments?|goals?|habits?)\s+(?:added|created|saved|scheduled|booked|logged|deleted|removed|renamed|cancell?ed|set|updated)\s*(?::|[.!…]|$)/gi;

/**
 * One locale's fabricated-completion claim tier. `claims` are the
 * perfective/completed assertion shapes (global regexes); a match counts only
 * when the containing sentence also names a `subjectNoun`, the claim's own
 * clause is not a question (terminator, embedded `? ？ ¿`, or `questionTail`
 * particle), the sentence prefix before the match does not end in a
 * `nonAssertiveLead` (negation, subordination, second-person subject, or
 * offer scaffolding), and the text right after the match does not continue
 * into a `subordinateTail` that makes the completed verb non-factive.
 *
 * `questionTail`, `subordinateTail`, and `courtesyTag` are matched with the
 * sticky flag at a computed offset so no per-match copy of the remaining text
 * is allocated; every consumer sets `lastIndex` immediately before testing.
 */
interface LocaleSideEffectClaimShapes {
	readonly locale: string;
	readonly subjectNoun: RegExp;
	readonly claims: readonly RegExp[];
	readonly nonAssertiveLead: RegExp;
	readonly questionTail?: RegExp;
	/**
	 * Agglutinating locales attach conditional/embedded-question/quotative
	 * endings directly to the same completed stem the claim matches, so the
	 * claim shape alone cannot tell "설정했어요" (a report) from "설정했으면"
	 * (a conditional). Sticky-matched at the offset immediately following the
	 * claim; a hit means the verb is not asserted as fact.
	 */
	readonly subordinateTail?: RegExp;
	/**
	 * Closing courtesy question this locale's assistant replies append after a
	 * completed report ("¿algo más?", "还需要别的吗？"). Sticky-matched at the
	 * offset just past a punctuation boundary: only a POSITIVE match here
	 * severs the clause, because punctuation alone cannot tell a trailing tag
	 * from coordination ("Criei, salvei e agendei o lembrete?") or a
	 * parenthetical ("He guardado, por error, el recordatorio?").
	 */
	readonly courtesyTag?: RegExp;
}

// Sentence terminators across the shipped locales: ASCII plus the full-width
// CJK set. Commas (including 、，) deliberately do NOT split — the noun gate
// should see the whole clause chain ("好了，提醒已保存。").
const MULTILINGUAL_SENTENCE_TERMINATOR = /[.!?。！？\n]/u;

// Punctuation that MAY introduce a trailing courtesy tag ("…, ¿algo más?",
// "…：还需要别的吗？", "… — mais alguma coisa?", "…… cần gì nữa không?", "…: ¿algo
// más?", "…- mais alguma coisa?"). This is only a candidate set: severing the
// clause additionally requires the locale's `courtesyTag` to match past the
// boundary, because the same punctuation also coordinates ("Criei, salvei e
// agendei o lembrete?") and brackets parentheticals ("He guardado, por error,
// el recordatorio?") — a punctuation hit alone never derives a clause span.
// Collected once per reply into a sorted offset array by
// `collectClauseTagBoundaries`; every lookup is a binary search against that
// array rather than a fresh `exec` scan (see its doc comment for why a
// per-match scan was quadratic on long boundary-sparse input).
const MULTILINGUAL_CLAUSE_TAG_BOUNDARY = /[,，、;；—–:：…-]/gu;

// Question-mark variants across the shipped locales, collected once per reply
// by `collectQuestionMarkPositions` rather than re-tested against a fresh
// clause slice per match — see that function's doc comment.
const MULTILINGUAL_QUESTION_MARK = /[?？¿]/gu;

const LOCALE_SIDE_EFFECT_CLAIM_SHAPES: readonly LocaleSideEffectClaimShapes[] =
	[
		{
			locale: "es",
			subjectNoun:
				/(?<![\p{L}])(?:recordatorios?|alarmas?|tareas?|citas?|calendario|rutinas?|h[áa]bitos?|metas?|objetivos?|notas?|apuntes?|pendientes?|seguimientos?|agenda|eventos?)(?![\p{L}])/iu,
			claims: [
				// "he guardado", "ya he creado", "te he programado"
				/(?<![\p{L}])(?:ya\s+)?(?:he|hemos)\s+(?:cread|guardad|programad|añadid|agregad|configurad|actualizad|eliminad|borrad|cancelad|apuntad|anotad|registrad|agendad)o/giu,
				// "acabo de crear un recordatorio"
				/(?<![\p{L}])acab(?:o|amos)\s+de\s+(?:crear|guardar|programar|añadir|agregar|configurar|actualizar|eliminar|borrar|cancelar|apuntar|anotar|registrar|agendar)/giu,
				// First-person preterite is unambiguous by conjugation: "guardé", "programé"
				/(?<![\p{L}])(?:guardé|creé|programé|agregué|añadí|configuré|actualicé|eliminé|borré|cancelé|anoté|registré|agendé|apunté)(?![\p{L}])/giu,
				// "tu recordatorio está programado", "queda guardado". Vague
				// readiness ("quedó listo", like English "is ready") is left to
				// the model's semantic replyEffectStatus classification.
				/(?<![\p{L}])(?:est[áa]n?|queda(?:n|ron)?|qued[óo])\s+(?:ya\s+)?(?:guardad|programad|cread|configurad|agendad|anotad|registrad)[oa]s?(?![\p{L}])/giu,
				// Participle-first openers: "Listo —", "Guardado."
				/(?:^|[.!?。！？\n]\s*)(?:listo|hecho|guardado|creado|agendado|programado|añadido|agregado)\s*[.!…—–:-]/giu,
			],
			nonAssertiveLead:
				/(?:(?<![\p{L}])(?:no|nunca|jamás|todav[íi]a\s+no|a[úu]n\s+no)\s+(?:(?:lo|la|los|las|le|les|te|me|se)\s+)?|(?:^|[,;—–-]\s*)(?:si|cuando|una\s+vez\s+que|en\s+cuanto|apenas|antes\s+de\s+que|mientras)\s+[^.!?\n]*)$/iu,
			courtesyTag:
				/[¿\s…]*(?:algo\s+m[áa]s|alguna\s+(?:otra\s+)?cosa|(?:necesitas|quieres|deseas|quer[íi]as)\s+algo|(?:te\s+)?ayudo\s+en\s+algo|puedo\s+ayudarte\s+en\s+(?:algo|otra)|en\s+qu[ée]\s+m[áa]s)/iuy,
		},
		{
			locale: "pt",
			subjectNoun:
				/(?<![\p{L}])(?:lembretes?|alarmes?|tarefas?|compromissos?|agenda|calend[áa]rio|rotinas?|h[áa]bitos?|metas?|objetivos?|notas?|anota[çc](?:[ãa]o|[õo]es)|pend[êe]ncias?|eventos?)(?![\p{L}])/iu,
			claims: [
				// First-person preterite: "criei", "já salvei", "agendei"
				/(?<![\p{L}])(?:j[áa]\s+)?(?:criei|salvei|guardei|agendei|adicionei|configurei|atualizei|apaguei|removi|cancelei|registrei|anotei|marquei)(?![\p{L}])/giu,
				// "acabei de criar o lembrete"
				/(?<![\p{L}])acabei\s+de\s+(?:criar|salvar|guardar|agendar|adicionar|configurar|atualizar|apagar|remover|cancelar|registrar|anotar|marcar)/giu,
				// "seu lembrete está salvo", "ficou agendado", "foi criado"
				/(?<![\p{L}])(?:est[áa]|est[ãa]o|ficou|ficaram|foi|foram)\s+(?:j[áa]\s+)?(?:salv|guardad|agendad|criad|configurad|registrad|anotad|marcad|atualizad)[oa]s?(?![\p{L}])/giu,
				// "Pronto —", "Feito.", "Salvo!"
				/(?:^|[.!?。！？\n]\s*)(?:pronto|feito|salvo|criado|agendado|adicionado)\s*[.!…—–:-]/giu,
			],
			nonAssertiveLead:
				/(?:(?<![\p{L}])(?:n[ãa]o|nunca|jamais|ainda\s+n[ãa]o)\s+(?:(?:o|a|os|as|lhe|lhes|te|me|se)\s+)?|(?:^|[,;—–-]\s*)(?:se|quando|assim\s+que|antes\s+de|depois\s+que|caso)\s+[^.!?\n]*)$/iu,
			courtesyTag:
				/[\s…]*(?:mais\s+alguma\s+coisa|algo\s+mais|(?:precisa|deseja|quer)\s+de?\s*mais|posso\s+ajudar\s+em\s+(?:mais|algo)|em\s+que\s+mais)/iuy,
		},
		{
			locale: "ko",
			subjectNoun:
				/(?:알림|리마인더|일정|할\s?일|습관|목표|메모|노트|루틴|캘린더|미리\s?알림|예약|과제|체크인)/u,
			claims: [
				// "저장했어요", "알림을 설정했습니다", "등록해 뒀어요", "저장되었습니다".
				// Adjacency is the negation guard: "저장 안 했어요" and future
				// volitionals ("저장할게요") never form 저장했/저장됐.
				/(?:저장|설정|추가|등록|예약|생성|기록|변경|수정|삭제|취소)(?:을|를)?\s*(?:완료했|했|해\s?두었|해\s?뒀|해\s?놓았|해\s?놨|되었|됐)/gu,
				// Headline noun form: "저장 완료!"
				/(?:저장|설정|추가|등록|예약|생성|기록)\s*완료/gu,
			],
			nonAssertiveLead: /(?:안|못)\s*$/u,
			questionTail: /(?:까요|나요|가요|을까)$/u,
			// Non-factive continuations of the same stem: conditionals
			// ("설정했으면", "설정했을 경우", "설정했을 때"), embedded/rhetorical
			// questions ("설정했는지", "설정했는가", "설정했을까"), and quotatives
			// that are explicitly hypothetical because a suppositional matrix
			// verb follows ("저장했다고 가정해", "…라고 치면"). A bare quotative is
			// NOT listed: "설정했다고 말씀드렸어요" reports the save as fact and
			// must keep firing. Factive-but-subordinate endings (-지만, -으니까)
			// are likewise absent: "설정했지만 알림이 안 왔어요" still asserts it.
			subordinateTail:
				/(?:으면|더라면|다면|라면|는지|은지|을지|는가|은가|을까|[을ㄹ]\s*(?:경우|때)|[다라]고\s*(?:[^\s]{1,6}\s*)?(?:가정|상상|치[고면]|셈\s*치))/uy,
			courtesyTag:
				/[\s…]*(?:더|또|다른|그\s*밖에)\s*(?:필요|도와|도움|궁금|원하시)/uy,
		},
		{
			locale: "tl",
			subjectNoun:
				/(?<![\p{L}])(?:paalala|alarma|gawain|iskedyul|tala|layunin|rutina|kalendaryo|appointment|tasks?|reminders?|notes?|habits?|goals?|todos?)(?![\p{L}])/iu,
			claims: [
				// Completed-aspect verb forms: "Naitakda ko na", "Nai-save",
				// "nakatakda na ang paalala". A following second-person/third-person
				// pronoun ("Na-save mo…") describes the USER's action, not the
				// agent's, and is excluded. Contemplated-aspect forms (reduplicated
				// "Ise-save", "Itatakda") are deliberately absent.
				/(?<![\p{L}-])(?:naitakda|naidagdag|nailagay|naitala|itinakda|idinagdag|inilagay|kinansela|tinanggal|inalis|nai-?saved?|na-?saved?|na-?set|naka-?set|nakatakda|na-?i?-?scheduled?|in-?updated?)(?![\p{L}])(?!\s+(?:mo|niya|nila|ninyo)(?![\p{L}]))/giu,
				/(?<![\p{L}])ginawa\s+ko\s+na(?![\p{L}])/giu,
			],
			nonAssertiveLead:
				/(?:(?<![\p{L}])(?:hindi|di)(?:\s+ko)?(?:\s+pa)?\s+|(?:^|[,;]\s*)(?:kung|kapag|bago|pagkatapos|para)\s+[^.!?\n]*)$/iu,
			questionTail: /\sba$/iu,
			courtesyTag:
				/[\s…]*(?:may\s+iba\s+pa|iba\s+pa\s+ba|meron\s+pa\s+ba|kailangan\s+mo\s+pa|ano\s+pa)/iuy,
		},
		{
			locale: "vi",
			subjectNoun:
				/(?:lời\s+nhắc|nhắc\s+nhở|báo\s+thức|công\s+việc|lịch\s+hẹn|lịch|ghi\s+chú|thói\s+quen|mục\s+tiêu|việc\s+cần\s+làm|nhiệm\s+vụ|sự\s+kiện|cuộc\s+hẹn)/iu,
			claims: [
				// Perfective "đã/vừa" + verb: "Mình đã đặt lời nhắc", "đã được lưu",
				// "đã giúp bạn tạo nhắc nhở"
				/(?:đã|vừa(?:\s+mới)?)\s+(?:được\s+|giúp\s+bạn\s+)?(?:đặt|lưu|tạo|thêm|lên\s+lịch|đặt\s+lịch|ghi(?:\s+lại)?|xóa|xoá|hủy|huỷ|cập\s+nhật|sửa|chỉnh)/giu,
				// verb + "xong (rồi)": "lưu xong rồi"
				/(?:đặt|lưu|tạo|thêm|ghi|xóa|xoá|hủy|huỷ|cập\s+nhật)\s+xong(?:\s+rồi)?/giu,
				// "Xong rồi —" opener (noun gate still applies to the sentence)
				/(?:^|[.!?。！？\n]\s*)(?:xong\s+rồi|đã\s+xong)\s*[.!…—–,:-]/giu,
			],
			// "chưa/không" negate; "sẽ/định/sắp" are future intent; a directly
			// preceding second-person pronoun describes the user's own action.
			nonAssertiveLead:
				/(?:(?:chưa|không|sẽ|định|sắp|muốn|nên|hãy|bạn|anh|chị|em|cậu)\s+|(?:^|[,;]\s*)(?:nếu|khi|trước\s+khi|giả\s+sử)\s+[^.!?\n]*)$/iu,
			questionTail: /(?:không|chưa|hả|à|phải\s+không)$/iu,
			courtesyTag:
				/[\s…]*(?:(?:bạn\s+)?c[ầa]n\s+(?:gì|chi)\s+(?:nữa|thêm)|còn\s+(?:gì|việc)\s+(?:gì\s+)?nữa|có\s+c[ầa]n\s+(?:gì|thêm)|tôi\s+có\s+thể\s+giúp\s+gì)/iuy,
		},
		{
			locale: "zh-CN",
			subjectNoun:
				/(?:提醒|闹钟|任务|日程|待办|备忘|笔记|习惯|目标|日历|打卡|事项|清单|例行)/u,
			claims: [
				// Perfective 了: "设置好了", "保存了", "已经…添加完了"
				/(?:设置|设定|保存|创建|添加|新建|安排|预约|记录|删除|取消|更新|修改)(?:好|完)?了/gu,
				// Perfective 已/已经 (covers passives: "提醒已保存")
				/已经?(?:为你|帮你|给你|被)?(?:设置|设定|保存|创建|添加|新建|安排|预约|记录|删除|取消|更新|修改)/gu,
			],
			// Negation/modality directly before the verb phrase; a sentence whose
			// subject is 你/您 with no 我 describes the USER's action ("你已经把提醒
			// 设置好了"), not the agent's — the tempered [^我] scan keeps "你好，我已
			// 经…" assertive.
			nonAssertiveLead:
				/(?:(?:没|没有|还没|尚未|未|不会|无法|不能|别|不用|无需)\s*|^(?:你|您)(?:(?!我)[^。！？!?\n])*|(?:^|[，,；;]\s*)(?:如果|要是|假如|万一|一旦)(?:(?!。)[^。！？!?\n])*)$/u,
			questionTail: /(?:吗|吧|呢|么)$/u,
			courtesyTag:
				/[\s…]*(?:还(?:需要|要|有)(?:别的|其他|什么|其它)|需要(?:别的|其他|其它)|(?:还有|其他)什么(?:需要|可以)|我还能(?:帮|做))/uy,
		},
	];

function localeClauseAround(
	text: string,
	index: number,
): { sentence: string; start: number; terminator: string } {
	let start = index;
	while (
		start > 0 &&
		!MULTILINGUAL_SENTENCE_TERMINATOR.test(text[start - 1] ?? "")
	) {
		start -= 1;
	}
	let end = index;
	while (
		end < text.length &&
		!MULTILINGUAL_SENTENCE_TERMINATOR.test(text[end] ?? "")
	) {
		end += 1;
	}
	return {
		sentence: text.slice(start, end),
		start,
		terminator: text[end] ?? "",
	};
}

/**
 * All clause-tag boundary offsets in `text`, collected with one forward pass.
 * Every consumer below queries this array by binary search instead of
 * re-running `MULTILINGUAL_CLAUSE_TAG_BOUNDARY.exec` from its own `from` —
 * an exec-per-match scan degrades to O(matches × distance-to-next-boundary),
 * which is quadratic on a long boundary-sparse sentence carrying many claim
 * tokens (measured: a repeated-claim Korean input with no punctuation went
 * from single-digit ms at ~3.5k chars to hundreds of ms at ~28k chars before
 * this change). Collecting once up front makes every subsequent lookup
 * O(log k) against the fixed boundary count `k`, so the whole scan stays
 * linear in `text.length`.
 */
function collectClauseTagBoundaries(text: string): readonly number[] {
	const boundaries: number[] = [];
	MULTILINGUAL_CLAUSE_TAG_BOUNDARY.lastIndex = 0;
	let boundary = MULTILINGUAL_CLAUSE_TAG_BOUNDARY.exec(text);
	while (boundary) {
		boundaries.push(boundary.index);
		boundary = MULTILINGUAL_CLAUSE_TAG_BOUNDARY.exec(text);
	}
	return boundaries;
}

/** Index of the first entry in the sorted `boundaries` array that is `>= from`. */
function firstBoundaryIndexAtOrAfter(
	boundaries: readonly number[],
	from: number,
): number {
	let lo = 0;
	let hi = boundaries.length;
	while (lo < hi) {
		const mid = (lo + hi) >>> 1;
		if ((boundaries[mid] as number) < from) {
			lo = mid + 1;
		} else {
			hi = mid;
		}
	}
	return lo;
}

/**
 * Offset of the first punctuation boundary at or after `from` (and before
 * `sentenceEnd`) that a locale `courtesyTag` positively matches past, or -1
 * when the sentence carries no trailing tag. Punctuation alone never severs
 * the clause: coordination ("Criei, salvei e agendei o lembrete?") and
 * parentheticals ("He guardado, por error, el recordatorio?") use the same
 * marks, and treating those as tags turns claim-governed questions into
 * fabricated-completion findings.
 */
function localeCourtesyTagStart(
	text: string,
	boundaries: readonly number[],
	from: number,
	sentenceEnd: number,
	courtesyTag: RegExp | undefined,
): number {
	if (!courtesyTag) return -1;
	let i = firstBoundaryIndexAtOrAfter(boundaries, from);
	while (i < boundaries.length) {
		const boundaryIndex = boundaries[i] as number;
		if (boundaryIndex >= sentenceEnd) break;
		// Every boundary char class member is a single UTF-16 code unit, so the
		// tag starts immediately after it.
		courtesyTag.lastIndex = boundaryIndex + 1;
		if (courtesyTag.test(text)) return boundaryIndex;
		i += 1;
	}
	return -1;
}

/** Offset of the first boundary at or after `from`, or `sentenceEnd`. */
function localeClauseCut(
	boundaries: readonly number[],
	from: number,
	sentenceEnd: number,
): number {
	const i = firstBoundaryIndexAtOrAfter(boundaries, from);
	const boundaryIndex = i < boundaries.length ? (boundaries[i] as number) : -1;
	return boundaryIndex >= 0 && boundaryIndex < sentenceEnd
		? boundaryIndex
		: sentenceEnd;
}

/**
 * All `?`/`？`/`¿` offsets in `text`, collected with the same one-pass
 * discipline as `collectClauseTagBoundaries`. "Does this clause contain a
 * question mark" is then a binary-search range check instead of a fresh
 * `RegExp.test` over a freshly sliced clause — on a long boundary-sparse
 * sentence the clause span can be nearly the whole reply, and re-slicing it
 * per match is exactly the quadratic cost this module was flagged for.
 */
function collectQuestionMarkPositions(text: string): readonly number[] {
	const positions: number[] = [];
	MULTILINGUAL_QUESTION_MARK.lastIndex = 0;
	let mark = MULTILINGUAL_QUESTION_MARK.exec(text);
	while (mark) {
		positions.push(mark.index);
		mark = MULTILINGUAL_QUESTION_MARK.exec(text);
	}
	return positions;
}

/** True when a collected question-mark position falls in `[start, end)`. */
function hasQuestionMarkInRange(
	positions: readonly number[],
	start: number,
	end: number,
): boolean {
	const i = firstBoundaryIndexAtOrAfter(positions, start);
	return i < positions.length && (positions[i] as number) < end;
}

// The longest fixed suffix any locale's `questionTail` pattern can match
// ("phải không" is the longest, at 10 characters). Trailing-tail detection
// only needs to see this many trimmed characters before the cut point, so
// bounding the lookback window keeps the check O(1) instead of O(clause
// length) regardless of how long the surrounding clause is.
const QUESTION_TAIL_LOOKBEHIND_WINDOW = 32;

/**
 * The trimmed window of `text` ending at `end`, capped to `maxLen`
 * characters. `questionTail` patterns are all `$`-anchored fixed suffixes, so
 * a bounded trailing window is sufficient — slicing the FULL clause (which,
 * on a long boundary-sparse sentence, can be nearly the whole reply) would
 * reintroduce the O(clause length)-per-match cost this module was flagged
 * for.
 */
function trailingTrimmedWindow(
	text: string,
	end: number,
	maxLen: number,
): string {
	let e = end;
	while (e > 0 && /\s/u.test(text[e - 1] as string)) {
		e -= 1;
	}
	const windowStart = Math.max(0, e - maxLen);
	return text.slice(windowStart, e);
}

// `nonAssertiveLead` clauses (negation, subordinators, second-person leads)
// are ordinary assistant-reply prose in every shipped locale, always far
// shorter than this. The cap only ever bites on adversarial/pathological
// input — the same long boundary-sparse sentence this module was flagged
// for — and keeps `text.slice(..., claimIndex)` bounded instead of growing
// with the claim's distance into a multi-kilobyte sentence.
const NON_ASSERTIVE_LEAD_LOOKBEHIND_WINDOW = 512;

function localeReplyClaimsCompletedSideEffect(text: string): boolean {
	// Sentence spans depend only on `text`, and repeated claim tokens inside one
	// long sentence would otherwise rescan it once per match. Reusing the span
	// while the next match falls inside it keeps the scan linear.
	let cached: { sentence: string; start: number; terminator: string } | null =
		null;
	// One forward pass over the whole reply, shared by every locale/claim/match
	// below — see `collectClauseTagBoundaries` and `collectQuestionMarkPositions`.
	const clauseTagBoundaries = collectClauseTagBoundaries(text);
	const questionMarkPositions = collectQuestionMarkPositions(text);
	for (const shapes of LOCALE_SIDE_EFFECT_CLAIM_SHAPES) {
		if (!shapes.subjectNoun.test(text)) continue;
		for (const claim of shapes.claims) {
			for (const match of text.matchAll(claim)) {
				const firstWordOffset = match[0].search(/[\p{L}\p{N}]/u);
				const claimIndex =
					(match.index ?? 0) + (firstWordOffset >= 0 ? firstWordOffset : 0);
				if (
					!cached ||
					claimIndex < cached.start ||
					claimIndex >= cached.start + cached.sentence.length
				) {
					cached = localeClauseAround(text, claimIndex);
				}
				const { sentence, start, terminator } = cached;
				if (!shapes.subjectNoun.test(sentence)) continue;
				const matchEnd = (match.index ?? 0) + match[0].length;
				const sentenceEnd = start + sentence.length;
				if (shapes.subordinateTail) {
					shapes.subordinateTail.lastIndex = matchEnd;
					if (shapes.subordinateTail.test(text)) continue;
				}

				// A particle-final question mark on the claim's OWN clause — the
				// span up to the first punctuation break — is claim-governed even
				// when a coordinated alternative follows ("我把提醒设置好了吗，还是
				// 没有？", "알림을 설정했나요, 아니면 아직인가요?").
				const ownClauseEnd = localeClauseCut(
					clauseTagBoundaries,
					matchEnd,
					sentenceEnd,
				);
				if (
					shapes.questionTail?.test(
						trailingTrimmedWindow(
							text,
							ownClauseEnd,
							QUESTION_TAIL_LOOKBEHIND_WINDOW,
						),
					)
				) {
					continue;
				}

				// Interrogativity otherwise governs the whole sentence, EXCEPT when a
				// recognized courtesy tag closes it: "He creado tus recordatorios —
				// ¿algo más?" is a report plus a separate follow-up, and the English
				// tier fires on exactly that shape by design.
				const tagStart = localeCourtesyTagStart(
					text,
					clauseTagBoundaries,
					matchEnd,
					sentenceEnd,
					shapes.courtesyTag,
				);
				const claimClauseEnd = tagStart >= 0 ? tagStart : sentenceEnd;
				if (
					hasQuestionMarkInRange(questionMarkPositions, start, claimClauseEnd)
				) {
					continue;
				}
				if (tagStart < 0 && (terminator === "?" || terminator === "？")) {
					continue;
				}
				const nonAssertiveLeadWindowStart = Math.max(
					start,
					claimIndex - NON_ASSERTIVE_LEAD_LOOKBEHIND_WINDOW,
				);
				if (
					shapes.nonAssertiveLead.test(
						text.slice(nonAssertiveLeadWindowStart, claimIndex),
					)
				) {
					continue;
				}
				return true;
			}
		}
	}
	return false;
}

export function replyClaimsCompletedSideEffect(reply: string): boolean {
	const original = reply.trim();
	// An explicitly introduced example or original quotation reports wording,
	// not a new effect. Keep the original reply intact; inspect only assertions
	// outside those spans. Unframed quotes and quoted tool results still count.
	const { spans } = claimQuoteContext(original, true);
	let text = original;
	for (let i = spans.length - 1; i >= 0; i--) {
		const span = spans[i];
		if (span.example) {
			text =
				text.slice(0, span.start) +
				// Keep a clause boundary so a following "Added todo" or "Done"
				// assertion cannot inherit the quotation's framing.
				" ".repeat(span.end - span.start - 1) +
				"." +
				text.slice(span.end);
		}
	}
	if (!text) return false;
	// Quoted wording can still name the object of an outside assertion.
	if (!SIDE_EFFECT_SUBJECT_NOUN_PATTERN.test(original)) {
		return localeReplyClaimsCompletedSideEffect(text);
	}
	if (stateSideEffectClaimHasLocalSubject(text)) return true;
	for (const match of text.matchAll(
		SUBJECTLESS_PAST_SIDE_EFFECT_CLAIM_PATTERN,
	)) {
		if (sideEffectClaimSentenceIsQuestion(text, match.index)) continue;
		return true;
	}
	for (const match of text.matchAll(NOUN_FIRST_SIDE_EFFECT_CLAIM_PATTERN)) {
		if (sideEffectClaimSentenceIsQuestion(text, match.index)) continue;
		return true;
	}
	for (const match of text.matchAll(PERFECTIVE_SIDE_EFFECT_CLAIM_PATTERN)) {
		if (
			!NON_ASSERTIVE_SIDE_EFFECT_LEAD_PATTERN.test(text.slice(0, match.index))
		) {
			return true;
		}
	}
	for (const match of text.matchAll(BARE_PAST_SIDE_EFFECT_CLAIM_PATTERN)) {
		const prefix = text.slice(0, match.index);
		if (NON_ASSERTIVE_SIDE_EFFECT_LEAD_PATTERN.test(prefix)) continue;
		if (sideEffectClaimSentenceIsQuestion(text, match.index)) continue;
		return true;
	}
	// English nouns can co-occur with non-English claim grammar (loanword
	// nouns in Tagalog, code-switched replies) — always try the locale tiers.
	return localeReplyClaimsCompletedSideEffect(text);
}

// Read-side twin of the completed-side-effect patterns above: assertions that
// the user's TRACKED WORK is empty/absent ("your task list is empty", "no
// notes, tasks, or messages from earlier today", "I don't have today's log").
// On a path where no read tool ran, such a reply conflates "not loaded" with
// "zero" — the exact conflation the error doctrine bans on data paths. Each
// branch is anchored to tracked-work nouns so ordinary chat ("no messages from
// Bob in this thread") passes through; chat-recall stays owned by the
// visible-context-recall exception.
const EMPTY_TRACKED_STATE_CLAIM_PATTERNS: readonly RegExp[] = [
	// Possessive collection assertions need proof even without a date qualifier.
	/\byou\s+(?:(?:currently|presently)\s+)?(?:have\s+(?:no|zero)|(?:do\s+not|don['’]t)\s+have\s+(?:any|a|an))\s+(?:(?:new|saved|tracked|recorded)\s+)?(?:notes?|tasks?|todos?|to[- ]dos?|reminders?|habits?|goals?|entries)\b/gi,
	// "your task list is empty", "the todo list looks clear"
	/\b(?:task|todo|to[- ]do|reminder|goal|habit)s?\s+list\s+(?:is|looks|seems|appears)\s+(?:empty|clear|blank)\b/gi,
	// "no notes, tasks, or messages from earlier today", "no tasks logged"
	/\b(?:no|zero)\s+(?:new\s+)?(?:notes?|tasks?|todos?|to[- ]dos?|reminders?|habits?|goals?|entries)\b[^.!?\n]*\b(?:today|tonight|this\s+morning|this\s+afternoon|this\s+evening|so\s+far|earlier|logged|recorded|saved|tracked|on\s+file)\b/gi,
	// "I don't have today's log (in front of me)", "I don't have your task list"
	/\bi\s+don['’]t\s+have\s+(?:today['’]s|your)\s+(?:log|notes?|list|tasks?|todos?)\b/gi,
	// "nothing logged today", "nothing was recorded this morning"
	/\bnothing\s+(?:is\s+|was\s+|got\s+)?(?:logged|recorded|written\s+down|saved|tracked)\b[^.!?\n]*\b(?:today|tonight|yesterday|this\s+(?:morning|afternoon|evening|week)|so\s+far)\b/gi,
	// "nothing on your list/schedule/plate"
	/\bnothing\s+(?:is\s+)?on\s+(?:your|the)\s+(?:list|schedule|plate|docket)\b/gi,
	// "your day is wide open", "your schedule looks clear"
	/\byour\s+(?:day|schedule|slate)\s+(?:is|looks|seems|appears)\s+(?:empty|clear|blank|free|wide\s+open)\b/gi,
];

// A subordinator opening the clause turns the match into a hypothetical ("If
// your task list is empty, we could…"), not a report of looked-up state.
const CONDITIONAL_EMPTY_CLAIM_LEAD_PATTERN =
	/\b(?:if|unless|when|whenever|once|whether|in\s+case)\b[^.!?\n]*$/i;

// Classify quotes once, retaining asserted reported results. Only explicit
// examples/wording are exempt; the projection prevents a quoted conditional
// from changing the grammar of a later unquoted assertion.
function claimQuoteContext(
	text: string,
	includeOriginalWording = false,
): {
	projection: string;
	spans: { start: number; end: number; example: boolean }[];
} {
	const spans: { start: number; end: number; example: boolean }[] = [];
	const projection = text.replace(
		/"(?:\\[^\r\n]|[^"\\\r\n])*"|“(?:\\[^\r\n]|[^”\\\r\n])*”|‘(?:\\[^\r\n]|[^’\\\r\n])*’|`(?:\\[^\r\n]|[^`\\\r\n])*`|(?<![\p{L}\p{N}])'(?:\\[^\r\n]|[^'\\\r\n])*'(?![\p{L}\p{N}])/gu,
		(quote: string, offset: number) => {
			const prefix = text.slice(0, offset);
			const example =
				/(?:\bfor\s+example[, :] *|\b(?:the\s+)?(?:example|phrase|wording)(?:\s+(?:says|asks|reads))?\s*:?\s*)$/i.test(
					prefix,
				) ||
				(includeOriginalWording &&
					/\b(?:original|earlier|previous)\s+(?:(?:assistant|user)(?:['’]s)?\s+)?(?:line|sentence|message|reply|statement|wording)(?:,\s*quoted\s+exactly,)?\s+(?:was|read|said)(?:\s+exactly)?\s*:?\s*$/i.test(
						prefix,
					));
			spans.push({ start: offset, end: offset + quote.length, example });
			return quote.replace(/[^\r\n]/g, " ");
		},
	);
	return { projection, spans };
}

// A negated ability to establish the immediately following proposition is
// explicit uncertainty, not an assertion of that proposition. Ending at the
// claim prevents uncertainty about an earlier clause from hiding a later claim.
const UNCERTAIN_EMPTY_CLAIM_LEAD_PATTERN =
	/\bi\s+(?:cannot|can\s+not|can['’]t|do\s+not|don['’]t|am\s+not\s+able\s+to)\s+(?:say|conclude|confirm|verify|establish|assert|tell)(?:\s+(?:for\s+(?:certain|sure)|with\s+confidence))?\s+(?:that\s+)?$/i;

// A negated mutation of existing records does not assert an empty collection.
// Keep the exception within its own clause so a later absence claim still runs.
const NO_RECORD_CHANGE_CLAUSE =
	/\b(?:no|zero)\s+(?:(?:existing|saved|new)\s+)?(?:notes?|tasks?|todos?|records?|settings|reminders?|events?)(?:\s*(?:,|and|or)\s*(?:(?:existing|saved|new)\s+)?(?:notes?|tasks?|todos?|records?|settings|reminders?|events?))*\s+(?:were|was|are|is|have\s+been|has\s+been)\s+(?:changed|modified|edited|deleted|removed|updated|overwritten)\b/gi;

/**
 * True when a reply ASSERTS that the user's tracked work (tasks, todos,
 * reminders, habits, goals, notes, day log) is empty or unavailable. On a path
 * where no read tool ran, that assertion fabricates an empty day — "not loaded
 * must never read as zero" applied to READS (#17059; observed live: a recap ask
 * routed contexts=["simple"] and answered "I don't have today's log in front of
 * me — no notes, tasks, or messages from earlier today", run 729acaf2).
 * Questions and conditionals pass through: asking the user whether their list
 * is empty is not a claim about looked-up state.
 */
export function replyClaimsEmptyTrackedWorkState(reply: string): boolean {
	const text = reply
		.trim()
		.replace(NO_RECORD_CHANGE_CLAUSE, (clause) => " ".repeat(clause.length));
	const { projection, spans } = claimQuoteContext(text);
	if (!text.trim()) return false;
	for (const pattern of EMPTY_TRACKED_STATE_CLAIM_PATTERNS) {
		let quoteIndex = 0;
		for (const match of text.matchAll(pattern)) {
			while (
				quoteIndex < spans.length &&
				spans[quoteIndex].end <= match.index
			) {
				quoteIndex++;
			}
			const candidate = spans[quoteIndex];
			const quote =
				candidate && candidate.start <= match.index ? candidate : undefined;
			if (quote?.example) continue;
			const prefix = quote
				? projection.slice(0, quote.start) +
					text.slice(quote.start + 1, match.index)
				: projection.slice(0, match.index);
			if (CONDITIONAL_EMPTY_CLAIM_LEAD_PATTERN.test(prefix)) continue;
			if (UNCERTAIN_EMPTY_CLAIM_LEAD_PATTERN.test(prefix)) continue;
			if (sideEffectClaimSentenceIsQuestion(text, match.index)) continue;
			return true;
		}
	}
	return false;
}
// ── Progress-promise detection ──────────────────────────────────────────────
// A short reply whose ENTIRE content is a promise to do work ("On it.",
// "Checking your list now.") asserts that background work is underway. On a
// simple-path turn that ran no tool and routed no async handoff, that promise
// is fabricated: nothing will ever deliver. Detection is deliberately
// whole-reply and length-bounded so substantive replies that merely contain a
// forward-looking clause ("I'll be honest…", "I'll need the event title —
// what is it?") never fire; questions are exempt like every detector here.
const PROGRESS_PROMISE_REPLY_PATTERN = new RegExp(
	String.raw`^[\s"'…–—-]*(?:` +
		String.raw`on it|will do|sure thing|you got it|no problem|right away|` +
		String.raw`one (?:sec|second|moment|min(?:ute)?)|just a (?:sec|second|moment|min(?:ute)?)|hold on|hang (?:on|tight)|gimme a (?:sec|second|minute)|` +
		String.raw`(?:i(?:['’]m|\s+am)\s+)?(?:checking|looking into|pulling up|grabbing|fetching|getting|working) (?:it|that|this|on it|[\w\s]{0,24}?)(?:\s+now)?|` +
		String.raw`i(?:['’]ll|\s+will) (?:check|look into|pull(?: that| it)? up|grab|fetch|get|handle|take care of)(?:\s[\w\s]{0,24})?|` +
		String.raw`let me (?:check|look into|pull(?: that| it)? up|grab|fetch|get)(?:\s[\w\s]{0,24})?` +
		String.raw`)[\s.!…✅👍🫡–—-]*$`,
	"iu",
);
const PROGRESS_PROMISE_MAX_LENGTH = 64;

/**
 * True when the whole reply is a bare promise of in-progress or imminent work
 * with no substantive content. Callers gate on turn state (no tool executed,
 * no async handoff routed) — the detector only classifies the text.
 */
export function replyClaimsInProgressWork(reply: string): boolean {
	const text = reply.trim();
	if (!text || text.length > PROGRESS_PROMISE_MAX_LENGTH) return false;
	if (text.includes("?")) return false;
	return PROGRESS_PROMISE_REPLY_PATTERN.test(text);
}
