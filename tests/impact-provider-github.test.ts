import { describe, it, expect, vi } from 'vitest';
import { getDiff } from '../src/impact/providers/base.js';

describe('Impact: GitHub provider', () => {
  it('fetches PR diff with correct Accept header and parses diff', async () => {
    const abs = '/tmp/fake.ts';
    const diff = `diff --git a/${abs} b/${abs}
index 0000000..1111111 100644
--- a/${abs}
+++ b/${abs}
@@ -1,0 +1,1 @@
+// changed
`;
    const mock = vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      text: async () => diff,
      status: 200,
      statusText: 'OK',
      headers: new Map(),
    });

    const res = await getDiff({ provider: 'github', repo: 'owner/repo', pr: 123 });
    expect(mock).toHaveBeenCalled();
    const args = (mock.mock.calls[0]![1]!);
    expect(args.headers.Accept).toBe('application/vnd.github.v3.diff');
    expect(res.files.length).toBe(1);
    expect(res.files[0].path).toBe(abs);

    mock.mockRestore();
  });
});


