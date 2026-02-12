use std::collections::{HashMap, VecDeque};

pub struct GroupQueue<T> {
    per_group: HashMap<String, VecDeque<T>>,
    capacity: usize,
}

impl<T> GroupQueue<T> {
    pub fn new(capacity: usize) -> Self {
        Self { per_group: HashMap::new(), capacity }
    }

    pub fn push(&mut self, group: &str, item: T) {
        let q = self.per_group.entry(group.to_string()).or_default();
        if q.len() < self.capacity {
            q.push_back(item);
        }
    }

    pub fn pop(&mut self, group: &str) -> Option<T> {
        self.per_group.get_mut(group).and_then(|q| q.pop_front())
    }
}
