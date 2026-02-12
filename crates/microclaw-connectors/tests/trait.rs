use microclaw_connectors::{Connector, ConnectorId};

struct Dummy;

impl Connector for Dummy {
    fn id(&self) -> ConnectorId {
        ConnectorId("dummy".into())
    }
}

#[test]
fn connector_id_is_stable() {
    let c = Dummy;
    assert_eq!(c.id().0, "dummy");
}
