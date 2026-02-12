use microclaw_queue::GroupQueue;

#[test]
fn preserves_fifo_per_group() {
    let mut q = GroupQueue::new(2);
    q.push("g1", "a");
    q.push("g1", "b");
    assert_eq!(q.pop("g1"), Some("a"));
    assert_eq!(q.pop("g1"), Some("b"));
}
