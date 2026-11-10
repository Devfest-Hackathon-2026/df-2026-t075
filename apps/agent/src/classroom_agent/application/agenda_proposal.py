"""Bind each Gemini tool call to the exact plan used to generate it."""

from collections.abc import Awaitable, Callable
from uuid import NAMESPACE_URL, uuid5

from classroom_agent.application.meeting_conversation import MeetingPrompt
from classroom_agent.application.voice_probe import ProbeError

INVALID = "変更するパートと分数を確認できませんでした。もう一度依頼してください。"
RESULTS = {
    "applied": "進行案を更新しました。",
    "pending": "変更案を出しました。画面で確認してください。",
    "agenda-stale": "進め方が変わったため、反映できませんでした。",
    "part-ended": "そのパートは終了しました。",
    "over-total": "部屋の合計時間を超えるため、ほかのパートから時間を振り替えてください。",
    "reflection-fixed": "最後の振り返りは2分で固定です。",
    "current-part-moved": "現在のパートの位置は変更できません。",
    "current-ends-too-soon": "その分数では現在のパートがすでに終了してしまいます。",
    "not-planning": "準備が始まると変更できます。",
    "discussion-required": "討議パートを一つ以上残してください。",
    "meeting-ended": "予定したパートはすべて終了しました。",
    "no-change": "共有中の予定と同じ内容です。",
}


async def meeting_answer(
    prompt: MeetingPrompt,
    request_id: str,
    generate: Callable[[str], Awaitable[str | dict[str, object]]],
    submit: Callable[[dict[str, object]], Awaitable[str]],
    research: Callable[[str, dict[str, object]], Awaitable[str]] | None = None,
) -> str:
    try:
        result = await generate(prompt.text)
    except Exception:
        raise ProbeError("gemini") from None
    if isinstance(result, str):
        if not result.strip():
            raise ProbeError("gemini")
        return result
    if isinstance(query := result.get("research"), dict) and research:
        return await research(request_id, query)
    if not prompt.part_ids or prompt.plan_version is None:
        return "現在の進行案を確認できなかったため、変更できませんでした。"
    proposal = proposal_body(prompt, request_id, result)
    if proposal is None:
        return INVALID
    status = await submit(proposal)
    return RESULTS.get(status, INVALID)


def proposal_body(
    prompt: MeetingPrompt, request_id: str, result: dict[str, object]
) -> dict[str, object] | None:
    operations = result.get("operations")
    reason = result.get("reason")
    if (
        not isinstance(operations, list)
        or not 1 <= len(operations) <= 24
        or not isinstance(reason, str)
    ):
        return None
    resolved = []
    for op in operations:
        if (
            not isinstance(op, dict)
            or not isinstance(op.get("target"), str)
            or op["target"] not in prompt.part_ids
        ):
            return None
        resolved.append({**op, "target": prompt.part_ids[op["target"]]})
    # Only one tool call is allowed per request. The HTTP adapter reuses the full envelope on retry.
    return {
        "id": str(uuid5(NAMESPACE_URL, f"ainote/requests/{request_id}/calls/1")),
        "basePlanVersion": prompt.plan_version,
        "reason": reason,
        "operations": resolved,
    }
