import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { ProtocolErrorCode } from "@modelcontextprotocol/server";
import { Transform, type Readable, type Writable } from "node:stream";

const MAX_MCP_STDIO_FRAME_BYTES = 10 * 1024 * 1024;

export function createParseErrorReportingStdin(input: Readable, output: Writable): Readable {
  let pending = Buffer.alloc(0);
  const processFrame = (rawFrame: Buffer, stream: Transform): Error | undefined => {
    const frame = rawFrame.at(-1) === 13 ? rawFrame.subarray(0, -1) : rawFrame;
    if (!frame.length) return;
    if (frame.length > MAX_MCP_STDIO_FRAME_BYTES) {
      return new Error("MCP stdio frame exceeded 10 MiB.");
    }
    try {
      JSON.parse(frame.toString("utf8"));
      stream.push(frame);
      stream.push("\n");
    } catch {
      output.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: null,
          error: { code: ProtocolErrorCode.ParseError, message: "Parse error" },
        })}\n`,
      );
    }
  };
  const filter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      pending = Buffer.concat([pending, chunk]);
      let newline = pending.indexOf(10);
      while (newline >= 0) {
        const error = processFrame(pending.subarray(0, newline), this);
        pending = pending.subarray(newline + 1);
        if (error !== undefined) {
          callback(error);
          return;
        }
        newline = pending.indexOf(10);
      }
      if (pending.length > MAX_MCP_STDIO_FRAME_BYTES) {
        callback(new Error("MCP stdio frame exceeded 10 MiB."));
        return;
      }
      callback();
    },
    flush(callback) {
      const error = processFrame(pending, this);
      pending = Buffer.alloc(0);
      callback(error);
    },
  });
  input.pipe(filter);
  return filter;
}

export function createCodegraphMcpStdioTransport(input: Readable, output: Writable): StdioServerTransport {
  return new StdioServerTransport(createParseErrorReportingStdin(input, output), output, {
    maxBufferSize: MAX_MCP_STDIO_FRAME_BYTES,
  });
}
