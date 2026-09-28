pub fn visible() {}
fn hidden() {}
pub(self) fn self_vis() {}
pub ( self ) fn spaced_self() {}
pub(in self) fn inner_self() {}
pub(crate) fn shared() {}
fn local() { hidden(); self_vis(); spaced_self(); inner_self(); shared(); }
