/**
 * Unit tests for ungrounded side-effect assertion detection and empty tracked work state claims.
 */

import { describe, expect, it } from "vitest";
import {
	replyClaimsCompletedSideEffect,
	replyClaimsEmptyTrackedWorkState,
} from "./side-effect-claims.js";

describe("side-effect-claims", () => {
	describe("replyClaimsCompletedSideEffect", () => {
		it.each([
			'The original assistant sentence was exactly: "I set it: for any future note, I would show its title and body before saving." That rule was revoked.',
			'The original line was: "I saved a note." This is quoted history, not a new action.',
			"The earlier reply was: “I scheduled a reminder.”",
			"The assistant's original sentence, quoted exactly, was: “I set it: for any future note, I would show its title and body before saving.”",
			"The assistant's original sentence was “I set it: for any future note, I would show its title and body before saving.”",
			'The phrase "I saved a note" is a completion claim.',
			'For example: "I scheduled a reminder."',
		])("does not turn explicit quoted wording into an effect: %s", (reply) => {
			expect(replyClaimsCompletedSideEffect(reply)).toBe(false);
		});

		it.each([
			'"I saved your note."',
			'The tool returned: "I saved your note."',
			'The result says: "Your reminders are set."',
			'I saved a note. The original line was: "I scheduled a reminder."',
			'The original line was: "I scheduled a reminder." I saved your note.',
			'The original line was: "I saved a note." Your reminders are set.',
			'The original line was: "I saved a note." Added todo: buy groceries.',
			'The original line was: "I saved a note." 已经把提醒设置好了。',
			'I saved the phrase: "a note".',
		])(
			"still detects current or unqualified claims around quotes: %s",
			(reply) => {
				expect(replyClaimsCompletedSideEffect(reply)).toBe(true);
			},
		);

		it("detects English first-person completed side effect claims", () => {
			expect(
				replyClaimsCompletedSideEffect("I've set a reminder for your meeting."),
			).toBe(true);
			expect(
				replyClaimsCompletedSideEffect("I scheduled the appointment for 3pm."),
			).toBe(true);
			expect(
				replyClaimsCompletedSideEffect("Done — your reminders are set."),
			).toBe(true);
			expect(replyClaimsCompletedSideEffect("Added todo: buy groceries.")).toBe(
				true,
			);
		});

		it("ignores consent-seeking offers and questions", () => {
			expect(
				replyClaimsCompletedSideEffect("Should I set a reminder for 9am?"),
			).toBe(false);
			expect(
				replyClaimsCompletedSideEffect("Would you like me to schedule a task?"),
			).toBe(false);
			expect(
				replyClaimsCompletedSideEffect(
					"When I set a reminder, I'll let you know.",
				),
			).toBe(false);
		});

		it("detects multilingual side effect assertions (Spanish, Portuguese, Chinese, Korean)", () => {
			expect(
				replyClaimsCompletedSideEffect(
					"He guardado el recordatorio para mañana.",
				),
			).toBe(true);
			expect(
				replyClaimsCompletedSideEffect("Já salvei a sua tarefa no calendário."),
			).toBe(true);
			expect(replyClaimsCompletedSideEffect("我已经帮你把提醒设置好了。")).toBe(
				true,
			);
			expect(replyClaimsCompletedSideEffect("알림을 설정했어요.")).toBe(true);
		});

		it("returns false on empty or whitespace strings", () => {
			expect(replyClaimsCompletedSideEffect("")).toBe(false);
			expect(replyClaimsCompletedSideEffect("   ")).toBe(false);
		});
	});

	describe("replyClaimsEmptyTrackedWorkState", () => {
		it("detects claims asserting empty or absent tracked work state", () => {
			expect(replyClaimsEmptyTrackedWorkState("Your task list is empty.")).toBe(
				true,
			);
			expect(replyClaimsEmptyTrackedWorkState("No tasks logged today.")).toBe(
				true,
			);
			expect(
				replyClaimsEmptyTrackedWorkState(
					"I don't have today's log in front of me.",
				),
			).toBe(true);
			expect(
				replyClaimsEmptyTrackedWorkState(
					"Nothing is on your schedule for tomorrow.",
				),
			).toBe(true);
		});

		it("ignores conditional or question assertions about empty state", () => {
			expect(
				replyClaimsEmptyTrackedWorkState(
					"If your task list is empty, we can create one.",
				),
			).toBe(false);
			expect(
				replyClaimsEmptyTrackedWorkState(
					"Is your schedule clear for this afternoon?",
				),
			).toBe(false);
		});

		it("returns false on empty string", () => {
			expect(replyClaimsEmptyTrackedWorkState("")).toBe(false);
			expect(replyClaimsEmptyTrackedWorkState("   ")).toBe(false);
		});
	});
});

describe("side-effect-claims — extended branch coverage", () => {
	describe("replyClaimsCompletedSideEffect", () => {
		it("detects perfective auxiliaries beyond the contraction form", () => {
			expect(
				replyClaimsCompletedSideEffect(
					"I have scheduled your appointment for Tuesday.",
				),
			).toBe(true);
			expect(
				replyClaimsCompletedSideEffect(
					"I just added a reminder to your calendar.",
				),
			).toBe(true);
			expect(
				replyClaimsCompletedSideEffect("I've updated your calendar settings."),
			).toBe(true);
		});

		it("keeps denials from reading as completed claims", () => {
			expect(
				replyClaimsCompletedSideEffect("I have not set any reminders yet."),
			).toBe(false);
		});

		it("fires on tag questions but not leading subordinators", () => {
			expect(
				replyClaimsCompletedSideEffect(
					"I've set your reminder — anything else?",
				),
			).toBe(true);
			expect(
				replyClaimsCompletedSideEffect(
					"Once I've set the reminder, I will let you know.",
				),
			).toBe(false);
		});

		it("separates bare-past reports from offers built on the same verb", () => {
			expect(replyClaimsCompletedSideEffect("I set a reminder for 9am.")).toBe(
				true,
			);
			expect(
				replyClaimsCompletedSideEffect(
					"Before I set the alarm, let me check your calendar.",
				),
			).toBe(false);
			expect(
				replyClaimsCompletedSideEffect(
					"I set reminders every morning — should I keep that?",
				),
			).toBe(false);
		});

		it("reads state-of-the-world completions without a first-person subject", () => {
			expect(replyClaimsCompletedSideEffect("Your reminders are set.")).toBe(
				true,
			);
			expect(replyClaimsCompletedSideEffect("It's all set for tomorrow.")).toBe(
				false,
			);
			expect(
				replyClaimsCompletedSideEffect("It's all set on your calendar."),
			).toBe(true);
			expect(
				replyClaimsCompletedSideEffect(
					"Saved! Your book report plan is now set up as reminders.",
				),
			).toBe(true);
		});

		it("does not misread congratulations or read-only navigation as writes", () => {
			expect(
				replyClaimsCompletedSideEffect(
					"Well done — that's every task cleared.",
				),
			).toBe(false);
			expect(
				replyClaimsCompletedSideEffect("Done — your notes are loaded."),
			).toBe(false);
			expect(
				replyClaimsCompletedSideEffect(
					"Done — your notes are loaded and I archived the old ones.",
				),
			).toBe(true);
		});

		it("anchors subjectless headline reports to sentence boundaries", () => {
			expect(
				replyClaimsCompletedSideEffect("Deleted the reminder as requested."),
			).toBe(true);
			expect(
				replyClaimsCompletedSideEffect("Added todo: sand the shelf?"),
			).toBe(false);
			expect(
				replyClaimsCompletedSideEffect(
					"Set a reminder on your phone to confirm.",
				),
			).toBe(false);
		});

		it("requires terminal punctuation on noun-first headlines", () => {
			expect(replyClaimsCompletedSideEffect("Reminder set: 9am.")).toBe(true);
			expect(
				replyClaimsCompletedSideEffect(
					"The reminder set by the old app still works.",
				),
			).toBe(false);
		});

		it("extends completion detection across the shipped locale tiers", () => {
			expect(
				replyClaimsCompletedSideEffect(
					"Mình đã đặt lời nhắc cho buổi họp rồi.",
				),
			).toBe(true);
			expect(
				replyClaimsCompletedSideEffect("Naitakda ko na ang paalala."),
			).toBe(true);
			expect(
				replyClaimsCompletedSideEffect(
					"He creado tus recordatorios — ¿algo más?",
				),
			).toBe(true);
		});

		it("rejects non-assertive locale shapes (negation, conditionals, second person, questions)", () => {
			expect(
				replyClaimsCompletedSideEffect(
					"No he guardado todavía el recordatorio.",
				),
			).toBe(false);
			expect(
				replyClaimsCompletedSideEffect("알림을 설정했으면 바로 알려주세요."),
			).toBe(false);
			expect(replyClaimsCompletedSideEffect("你已经把提醒设置好了。")).toBe(
				false,
			);
			expect(replyClaimsCompletedSideEffect("提醒已经保存了吗？")).toBe(false);
		});
	});

	describe("replyClaimsEmptyTrackedWorkState", () => {
		it("covers the remaining empty-state shapes", () => {
			expect(
				replyClaimsEmptyTrackedWorkState("Nothing logged today so far."),
			).toBe(true);
			expect(replyClaimsEmptyTrackedWorkState("Your day is wide open!")).toBe(
				true,
			);
			expect(
				replyClaimsEmptyTrackedWorkState("Zero reminders on file right now."),
			).toBe(true);
			expect(
				replyClaimsEmptyTrackedWorkState("I don't have your task list handy."),
			).toBe(true);
		});

		it("passes through conditionals and ordinary chat about absence", () => {
			expect(
				replyClaimsEmptyTrackedWorkState(
					"Whenever your schedule looks clear, tell me.",
				),
			).toBe(false);
			expect(
				replyClaimsEmptyTrackedWorkState(
					"No messages from Bob in this thread.",
				),
			).toBe(false);
		});
	});
});
