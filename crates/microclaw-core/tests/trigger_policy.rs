use microclaw_core::{create_trigger_pattern, should_process, should_require_trigger, Message};

#[test]
fn trigger_pattern_matches_start_case_insensitive() {
    let pattern = create_trigger_pattern("@Andy");
    assert!(pattern.is_match("@Andy hello"));
    assert!(pattern.is_match("@andy hello"));
    assert!(pattern.is_match("@ANDY hello"));
}

#[test]
fn trigger_pattern_requires_start_and_word_boundary() {
    let pattern = create_trigger_pattern("@Andy");
    assert!(!pattern.is_match("hello @Andy"));
    assert!(!pattern.is_match("@Andrew hello"));
    assert!(pattern.is_match("@Andy"));
    assert!(pattern.is_match("@Andy's thing"));
}

#[test]
fn trigger_pattern_normalizes_missing_at_prefix() {
    let pattern = create_trigger_pattern("Helper");
    assert!(pattern.is_match("@Helper do thing"));
    assert!(!pattern.is_match("@Andy do thing"));
}

#[test]
fn should_require_trigger_matches_nanoclaw_logic() {
    assert!(should_require_trigger(false, None));
    assert!(should_require_trigger(false, Some(true)));
    assert!(!should_require_trigger(false, Some(false)));
    assert!(!should_require_trigger(true, None));
    assert!(!should_require_trigger(true, Some(true)));
}

#[test]
fn should_process_respects_requires_trigger_and_custom_trigger() {
    let msgs = vec![Message::new("hello no trigger")];
    assert!(should_process(true, None, "@Andy", &msgs));
    assert!(!should_process(false, None, "@Andy", &msgs));
    assert!(!should_process(false, Some(true), "@Andy", &msgs));
    assert!(should_process(false, Some(false), "@Andy", &msgs));

    let trigger_msgs = vec![Message::new("@Helper do something")];
    assert!(should_process(false, Some(true), "@Helper", &trigger_msgs));
    assert!(!should_process(false, Some(true), "@Helper", &[Message::new("@Andy do something")]));
}
