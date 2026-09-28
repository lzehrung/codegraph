const Self = struct {
    pub fn helper() void {}
    pub fn caller() void { helper(); }
};
