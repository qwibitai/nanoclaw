# DeepWiki Q&A with Code Context for Repository: xuiltul/animaworks
## Q1
会話履歴の保存方式ってどうなってる？
### Answer
## 会話履歴の保存方式

AnimaWorksの会話履歴は、`ConversationMemory`クラスによって管理され、各Animaのディレクトリ内の`state/conversation.json`に構造化されて保存されます animaworks:488-514 。

### 保存場所と形式

- **メイン保存**: `~/.animaworks/animas/{anima名}/state/conversation.json`
- **活動ログ**: `activity_log/` ディレクトリにJSONL形式で全インタラクションを記録 animaworks:151-151 
- **添付ファイル**: 会話ターンに添付ファイルパスを保存可能 animaworks:190-195 

### 会話のライフサイクル

1. **保存**: ユーザー入力とアシスタント応答が`ConversationTurn`として保存 animaworks:511-537 
2. **圧縮**: 50ターンを超えると自動的にLLMで要約され、最新の25ターンのみ保持 animaworks:103-149 
3. **表示**: 履歴表示時は最新のターンからページネーションで取得 animaworks:41-46 

### 圧縮の詳細

- `needs_compression()`で圧縮必要性を判定
- `compress_if_needed()`でLLMを使用して古いターンを要約
- 圧縮後は`compressed_summary`と`compressed_turn_count`を保持 animaworks:89-106 

---

## Notes

会話履歴は短期記憶（`shortterm/`）とは別に管理され、セッションを超えて維持されます。また、大きなメッセージは保存時に自動的に切り詰められ、ストレージ容量を制御しています animaworks:44-56 。

Wiki pages you might want to explore:
- [Key Concepts and Terminology (xuiltul/animaworks)](/wiki/xuiltul/animaworks#1.1)
- [Creating Your First Anima (xuiltul/animaworks)](/wiki/xuiltul/animaworks#2.2)
### Citations
**File:** core/anima.py (L488-537)
```python
                # Build history-aware prompt via conversation memory
                conv_memory = ConversationMemory(self.anima_dir, self.model_config, thread_id=thread_id)
                await conv_memory.compress_if_needed()

                # Determine prompt and history strategy per execution mode
                mode = self.agent.execution_mode
                prior_messages = None
                if mode == "s":
                    # S mode: SDK manages conversation history internally,
                    # but we still save turns for downstream memory processes.
                    prompt = content
                elif mode == "a":
                    # A mode: AnimaWorks manages history via structured messages
                    prior_messages = conv_memory.build_structured_messages(content)
                    prompt = content
                elif mode == "b":
                    prompt = conv_memory.build_chat_prompt(
                        content, from_person, max_history_chars=2000,
                    )
                else:
                    prompt = conv_memory.build_chat_prompt(content, from_person)

                # Pre-save: persist user input before agent execution
                conv_memory.append_turn(
                    "human", content, attachments=attachment_paths or [],
                )
                conv_memory.save()

                # Activity log: message received
                self._activity.log("message_received", content=content, summary=content[:100], from_person=from_person, channel="chat", meta={"from_type": "human", "thread_id": thread_id})

                try:
                    result = await self.agent.run_cycle(
                        prompt, trigger=f"message:{from_person}",
                        message_intent=intent,
                        images=images,
                        prior_messages=prior_messages,
                    )
                    self._last_activity = now_jst()

                    # Record assistant response with tool records
                    tool_records = [
                        ToolRecord.from_dict(r)
                        for r in result.tool_call_records
                    ]
                    conv_memory.append_turn(
                        "assistant", result.summary,
                        tool_records=tool_records,
                    )
                    conv_memory.save()
```
**File:** README_ja.md (L151-151)
```markdown
| `activity_log/` | 統一タイムライン | 全インタラクション（JSONL） |
```
**File:** tests/unit/test_multimodal_image.py (L190-195)
```python
        conv.append_turn("human", "look at this", attachments=["attachments/img.png"])
        conv.save()

        state = conv.load()
        assert len(state.turns) == 1
        assert state.turns[0].attachments == ["attachments/img.png"]
```
**File:** tests/e2e/test_conversation_turn_limit_e2e.py (L103-149)
```python
    async def test_compression_triggers_at_51_turns_e2e(self, tmp_path: Path):
        """Append 51 turns, verify needs_compression() is True, run
        compress_if_needed(), verify only _MAX_DISPLAY_TURNS turns remain."""
        anima_dir = tmp_path / "animas" / "turn-limit-compress"
        conv = _make_conv_memory(anima_dir)

        # Append 51 turns (exceeds _MAX_TURNS_BEFORE_COMPRESS = 50)
        _populate_turns(conv, 51)

        # Verify stored count
        data = _read_conversation_json(anima_dir)
        assert len(data["turns"]) == 51

        # needs_compression() should trigger on the turn-count rule
        with patch(
            "core.prompt.context.resolve_context_window",
            return_value=200_000,
        ):
            assert conv.needs_compression() is True

        # Run compression with mocked LLM
        with (
            patch(
                "core.prompt.context.resolve_context_window",
                return_value=200_000,
            ),
            patch.object(
                conv,
                "_call_compression_llm",
                new_callable=AsyncMock,
                return_value="Summary of older conversation turns.",
            ),
        ):
            result = await conv.compress_if_needed()

        assert result is True

        # Reload from disk and verify
        conv_fresh = _make_conv_memory(anima_dir)
        state = conv_fresh.load()

        # After compression, exactly _MAX_DISPLAY_TURNS recent turns are kept
        assert len(state.turns) == _MAX_DISPLAY_TURNS
        # Compressed summary should be set
        assert "Summary" in state.compressed_summary
        # Compressed turn count should reflect the removed turns
        assert state.compressed_turn_count == 51 - _MAX_DISPLAY_TURNS
```
**File:** tests/unit/core/memory/test_conversation_pagination.py (L41-46)
```python
def _paginate(turns, limit, offset):
    """Apply the same pagination logic used in memory_routes.py."""
    total = len(turns)
    end = max(0, total - offset)
    start = max(0, end - limit)
    return turns[start:end]
```
**File:** tests/e2e/test_conversation_memory.py (L89-106)
```python
        assert conv_mem.needs_compression()

        # Mock the compression LLM call
        with patch_anthropic_compression(
            summary_text="Summary of 20 conversation turns about various topics."
        ):
            compressed = await conv_mem.compress_if_needed()

        assert compressed is True

        # Verify state after compression
        fresh = ConversationMemory(anima_dir, model_config)
        state = fresh.load()
        assert state.compressed_summary
        assert "Summary" in state.compressed_summary
        assert state.compressed_turn_count > 0
        # Fewer turns remain after compression (kept 25% = 5 turns)
        assert len(state.turns) < 20
```
**File:** tests/e2e/test_prompt_size_guard_e2e.py (L44-56)
```python
    def test_large_human_message_stored_truncated(self, anima_dir):
        """Large human message is truncated at storage time."""
        mem = ConversationMemory(anima_dir, ModelConfig())
        big_msg = "AWS log output: " + "ERROR something " * 500  # ~8000 chars
        mem.append_turn("human", big_msg)
        mem.save()

        # Reload from disk to verify persistence
        mem2 = ConversationMemory(anima_dir, ModelConfig())
        state = mem2.load()
        assert len(state.turns) == 1
        assert len(state.turns[0].content) <= _MAX_STORED_CONTENT_CHARS + 100  # +margin for truncation notice
        assert "[...truncated" in state.turns[0].content
```