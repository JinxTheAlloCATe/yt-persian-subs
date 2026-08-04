// Keep development-only files out of the packaged add-on. The test harness
// uses the Function constructor, which trips AMO's eval check, and it has no
// business being inside a shipped extension either way.
module.exports = {
  ignoreFiles: ['test/**', 'web-ext-artifacts/**', '.amo-upload-uuid', 'web-ext-config.cjs'],
};
