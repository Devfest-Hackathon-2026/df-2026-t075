import asyncio
import json
from unittest.mock import AsyncMock

import pytest

from classroom_agent.application.agenda_proposal import INVALID, meeting_answer
from classroom_agent.application.meeting_conversation import Conversation, Utterance
from classroom_agent.application.voice_probe import ProbeError

STATE: dict[str, object] = {
    "planVersion": 6,
    "parts": [{"partId": "part-5"}, {"partId": "legacy-4"}],
    "notes": [{"partId": "legacy-4", "text": "候補"}],
    "currentPartId": "part-5",
}
TOOL = {"operations": [{"action": "resize", "target": "P2", "minutes": 5}], "reason": "比較"}


def test_only_the_frozen_aliases_and_plan_revision_cross_the_write_boundary() -> None:
    async def run() -> None:
        generate = AsyncMock(return_value=TOOL)
        submit = AsyncMock(return_value="pending")
        conversation = Conversation()
        asked = [Utterance("A", 0, 1, "比較の時間を取って")]
        prompt = conversation.prompt(asked, STATE, 1)
        assert STATE["currentPartId"] == "part-5"
        for _ in range(2):
            assert "画面で確認" in await meeting_answer(prompt, "turn", generate, submit)
        assert generate.await_args is not None
        state = json.loads(generate.await_args.args[0])["進行状況"]
        assert state["parts"] == [{"partId": "P1"}, {"partId": "P2"}]
        assert state["notes"][0]["partId"] == "P2" and state["currentPartId"] == "P1"
        calls = submit.await_args_list
        assert calls[0] == calls[1]
        body = calls[0].args[0]
        assert body["basePlanVersion"] == 6 and body["operations"][0]["target"] == "legacy-4"
        generate.return_value = {"reason": "比較", "operations": [{"target": "P3"}]}
        assert await meeting_answer(prompt, "other", generate, submit) == INVALID
        generate.return_value = {"reason": "比較", "operations": []}
        assert await meeting_answer(prompt, "other", generate, submit) == INVALID
        generate.return_value = TOOL
        assert "確認できなかった" in await meeting_answer(
            conversation.prompt(asked, {}, 1), "other", generate, submit
        )
        assert submit.await_count == 2
        generate.return_value = "予算は3万円です。"
        assert await meeting_answer(prompt, "question", generate, submit) == generate.return_value
        for response in ("", RuntimeError("private")):
            generate.return_value = response
            if isinstance(response, Exception):
                generate.side_effect = response
            with pytest.raises(ProbeError, match="gemini"):
                await meeting_answer(prompt, "other", generate, submit)

    asyncio.run(run())
