self.addEventListener("message", (event) => {
  const taskId = event.data.taskId;
  const task = event.data.task;
  const payload = event.data.payload;

  try {
    if (task === "toJson") {
      const parsedLua = parseLuaTable(payload.luaText);
      self.postMessage({ taskId, ok: true, result: { jsonText: JSON.stringify(parsedLua, null, 2) } });
      return;
    }

    if (task === "importLua") {
      const parsedLua = parseLuaTable(payload.text);
      self.postMessage({ taskId, ok: true, result: { text: toLua(parsedLua).trim() } });
      return;
    }

    if (task === "importJson") {
      const parsedJson = JSON.parse(payload.text);
      self.postMessage({ taskId, ok: true, result: { text: JSON.stringify(parsedJson, null, 2) } });
      return;
    }

    if (task === "toLua") {
      const parsedJson = JSON.parse(payload.jsonText);
      const groupedResult = maybeGroupByKey(parsedJson, payload.groupByKey);
      let transformed = groupedResult.transformed;
      let compressedInfo = "";
      let simplifiedInfo = "";

      if (groupedResult.grouped) {
        const simplified = maybeSimplifyGroupedSingleField(transformed);
        transformed = simplified.transformed;
        if (simplified.simplifiedCount > 0) {
          simplifiedInfo = `，${simplified.simplifiedCount} 个分组已简化为纯值数组`;
        }

        const compressGrouped = maybeCompressGroupedData(
          transformed,
          payload.useHeaderData,
          payload.headerThreshold
        );
        transformed = compressGrouped.transformed;
        if (compressGrouped.compressedCount > 0) {
          compressedInfo = `，${compressGrouped.compressedCount} 个分组已转 header/data`;
        }

        self.postMessage({
          taskId,
          ok: true,
          result: {
            luaText: toLua(transformed).trim(),
            statusMessage: `JSON -> Lua 转换成功，按 ${groupedResult.keyName} 分组为 ${groupedResult.groupCount} 组${simplifiedInfo}${compressedInfo}`,
          },
        });
        return;
      }

      const converted = maybeConvertToHeaderData(
        transformed,
        payload.useHeaderData,
        payload.headerThreshold
      );
      transformed = converted.transformed;
      if (converted.compressed) {
        compressedInfo = `，已压缩为 header/data（${converted.colCount} 列，${converted.rowCount} 行）`;
      }

      self.postMessage({
        taskId,
        ok: true,
        result: {
          luaText: toLua(transformed).trim(),
          statusMessage: `JSON -> Lua 转换成功${compressedInfo}`,
        },
      });
      return;
    }

    if (task === "exportLua") {
      const parsedLua = parseLuaTable(payload.text);
      self.postMessage({
        taskId,
        ok: true,
        result: {
          fileName: "converted.lua",
          mime: "text/plain;charset=utf-8",
          content: toLua(parsedLua).trim(),
        },
      });
      return;
    }

    if (task === "exportLuaMin") {
      const parsedLua = parseLuaTable(payload.text);
      self.postMessage({
        taskId,
        ok: true,
        result: {
          fileName: "converted.min.lua",
          mime: "text/plain;charset=utf-8",
          content: toLuaMinified(parsedLua),
        },
      });
      return;
    }

    if (task === "exportJson") {
      const parsedJson = JSON.parse(payload.text);
      self.postMessage({
        taskId,
        ok: true,
        result: {
          fileName: "converted.json",
          mime: "application/json;charset=utf-8",
          content: JSON.stringify(parsedJson, null, 2),
        },
      });
      return;
    }

    if (task === "exportJsonMin") {
      const parsedJson = JSON.parse(payload.text);
      self.postMessage({
        taskId,
        ok: true,
        result: {
          fileName: "converted.min.json",
          mime: "application/json;charset=utf-8",
          content: JSON.stringify(parsedJson),
        },
      });
      return;
    }

    throw new Error("未知任务类型");
  } catch (error) {
    self.postMessage({
      taskId,
      ok: false,
      error: error && error.message ? error.message : "转换失败",
    });
  }
});

function isLuaIdentifier(key) {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(key);
}

function isIntegerKeyString(key) {
  return /^-?(?:0|[1-9]\d*)$/.test(key);
}

function luaEscapeString(value) {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t")
    .replace(/"/g, '\\"');
}

function formatLuaKey(key) {
  if (isLuaIdentifier(key)) return key;
  if (isIntegerKeyString(key)) return `[${key}]`;
  return `["${luaEscapeString(key)}"]`;
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function maybeConvertToHeaderData(value, useHeaderData, threshold) {
  if (!useHeaderData) {
    return { transformed: value, compressed: false };
  }
  if (!Array.isArray(value) || value.length === 0 || !value.every((item) => isPlainObject(item))) {
    return { transformed: value, compressed: false };
  }

  const header = [];
  const seen = new Set();
  value.forEach((record) => {
    Object.keys(record).forEach((key) => {
      if (!seen.has(key)) {
        seen.add(key);
        header.push(key);
      }
    });
  });

  if (header.length < threshold) {
    return { transformed: value, compressed: false };
  }

  const data = value.map((record) =>
    header.map((key) => (Object.prototype.hasOwnProperty.call(record, key) ? record[key] : null))
  );

  return {
    transformed: { header, data },
    compressed: true,
    rowCount: data.length,
    colCount: header.length,
  };
}

function maybeGroupByKey(value, keyName) {
  const name = (keyName || "").trim();
  if (!name) {
    return { transformed: value, grouped: false };
  }

  if (!Array.isArray(value) || value.length === 0 || !value.every((item) => isPlainObject(item))) {
    return { transformed: value, grouped: false };
  }

  const grouped = {};
  for (const record of value) {
    if (!Object.prototype.hasOwnProperty.call(record, name)) {
      throw new Error(`存在记录缺少分组键: ${name}`);
    }

    const groupKey = String(record[name]);
    const item = { ...record };
    delete item[name];

    if (!Object.prototype.hasOwnProperty.call(grouped, groupKey)) {
      grouped[groupKey] = [];
    }
    grouped[groupKey].push(item);
  }

  return {
    transformed: grouped,
    grouped: true,
    keyName: name,
    groupCount: Object.keys(grouped).length,
  };
}

function maybeCompressGroupedData(value, useHeaderData, threshold) {
  if (!isPlainObject(value)) {
    return { transformed: value, compressedCount: 0 };
  }

  let compressedCount = 0;
  const out = {};
  Object.keys(value).forEach((key) => {
    const result = maybeConvertToHeaderData(value[key], useHeaderData, threshold);
    out[key] = result.transformed;
    if (result.compressed) compressedCount += 1;
  });

  return { transformed: out, compressedCount };
}

function maybeSimplifyGroupedSingleField(value) {
  if (!isPlainObject(value)) {
    return { transformed: value, simplifiedCount: 0 };
  }

  let simplifiedCount = 0;
  const out = {};
  Object.keys(value).forEach((key) => {
    const groupRows = value[key];
    const canSimplify =
      Array.isArray(groupRows) &&
      groupRows.length > 0 &&
      groupRows.every((row) => isPlainObject(row) && Object.keys(row).length === 1);

    if (!canSimplify) {
      out[key] = groupRows;
      return;
    }

    out[key] = groupRows.map((row) => {
      const onlyKey = Object.keys(row)[0];
      return row[onlyKey];
    });
    simplifiedCount += 1;
  });

  return { transformed: out, simplifiedCount };
}

function toLua(value, indent = 0) {
  const pad = "  ".repeat(indent);
  const nextPad = "  ".repeat(indent + 1);

  if (value === null) return "nil";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("JSON 中包含 Infinity/NaN，Lua 不支持");
    return String(value);
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") return `"${luaEscapeString(value)}"`;

  if (Array.isArray(value)) {
    if (value.length === 0) return "{}";
    const lines = value.map((item) => `${nextPad}${toLua(item, indent + 1)}`);
    return `\n${pad}{\n${lines.join(",\n")}\n${pad}}`;
  }

  if (typeof value === "object") {
    const keys = Object.keys(value);
    if (keys.length === 0) return "{}";
    const objLines = keys.map((key) => `${nextPad}${formatLuaKey(key)} = ${toLua(value[key], indent + 1)}`);
    return `\n${pad}{\n${objLines.join(",\n")}\n${pad}}`;
  }

  throw new Error("检测到不支持的 JSON 值类型");
}

function toLuaMinified(value) {
  if (value === null) return "nil";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("JSON 中包含 Infinity/NaN，Lua 不支持");
    return String(value);
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") return `"${luaEscapeString(value)}"`;

  if (Array.isArray(value)) {
    if (value.length === 0) return "{}";
    return `{${value.map((item) => toLuaMinified(item)).join(",")}}`;
  }

  if (typeof value === "object") {
    const keys = Object.keys(value);
    if (keys.length === 0) return "{}";
    return `{${keys.map((key) => `${formatLuaKey(key)}=${toLuaMinified(value[key])}`).join(",")}}`;
  }

  throw new Error("检测到不支持的 JSON 值类型");
}

function parseLuaTable(input) {
  const s = input.trim();
  let i = 0;

  function error(msg) {
    throw new Error(`${msg} (位置 ${i + 1})`);
  }

  function peek() {
    return s[i];
  }

  function skipWhitespace() {
    while (i < s.length && /\s/.test(s[i])) i += 1;
  }

  function expect(ch) {
    skipWhitespace();
    if (s[i] !== ch) error(`期望 '${ch}'`);
    i += 1;
  }

  function parseString() {
    skipWhitespace();
    const quote = s[i];
    if (quote !== '"' && quote !== "'") error("期望字符串");
    i += 1;
    let out = "";
    while (i < s.length) {
      const ch = s[i];
      if (ch === quote) {
        i += 1;
        return out;
      }
      if (ch === "\\") {
        i += 1;
        if (i >= s.length) error("字符串转义不完整");
        const esc = s[i];
        const map = { n: "\n", r: "\r", t: "\t", "\\": "\\", '"': '"', "'": "'" };
        out += Object.prototype.hasOwnProperty.call(map, esc) ? map[esc] : esc;
        i += 1;
        continue;
      }
      out += ch;
      i += 1;
    }
    error("字符串未闭合");
  }

  function parseIdentifier() {
    skipWhitespace();
    const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(s.slice(i));
    if (!m) return null;
    i += m[0].length;
    return m[0];
  }

  function parseNumber() {
    skipWhitespace();
    const m = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(s.slice(i));
    if (!m) error("期望数字");
    i += m[0].length;
    return Number(m[0]);
  }

  function parseValue() {
    skipWhitespace();
    const ch = peek();
    if (ch === "{") return parseTable();
    if (ch === '"' || ch === "'") return parseString();
    if (ch === "-" || /\d/.test(ch)) return parseNumber();

    const id = parseIdentifier();
    if (id === null) error("无法解析值");
    if (id === "true") return true;
    if (id === "false") return false;
    if (id === "nil") return null;
    return id;
  }

  function parseTable() {
    expect("{");
    skipWhitespace();
    const arr = [];
    const obj = {};
    let seqIndex = 1;
    let hasObjKey = false;
    let hasArrValue = false;

    while (i < s.length) {
      skipWhitespace();
      if (peek() === "}") {
        i += 1;
        break;
      }

      let consumedKey = false;
      let key;
      let value;

      if (peek() === "[") {
        i += 1;
        skipWhitespace();
        key = parseValue();
        skipWhitespace();
        expect("]");
        skipWhitespace();
        expect("=");
        value = parseValue();
        consumedKey = true;
      } else {
        const start = i;
        const id = parseIdentifier();
        if (id !== null) {
          skipWhitespace();
          if (peek() === "=") {
            i += 1;
            key = id;
            value = parseValue();
            consumedKey = true;
          } else {
            i = start;
            value = parseValue();
          }
        } else {
          value = parseValue();
        }
      }

      if (consumedKey) {
        const keyType = typeof key;
        if (keyType !== "string" && keyType !== "number") {
          error("Lua table 键仅支持字符串或数字");
        }
        if (typeof key === "number" && Number.isInteger(key) && key > 0 && key === seqIndex) {
          arr.push(value);
          seqIndex += 1;
          hasArrValue = true;
        } else {
          obj[String(key)] = value;
          hasObjKey = true;
        }
      } else {
        arr.push(value);
        seqIndex += 1;
        hasArrValue = true;
      }

      skipWhitespace();
      if (peek() === "," || peek() === ";") {
        i += 1;
        continue;
      }
      if (peek() === "}") {
        i += 1;
        break;
      }
      error("字段之间应使用 ','、';' 或结束 '}'");
    }

    if (hasObjKey && hasArrValue) {
      arr.forEach((v, idx) => {
        obj[String(idx + 1)] = v;
      });
      return obj;
    }
    return hasObjKey ? obj : arr;
  }

  const out = parseValue();
  skipWhitespace();
  if (i !== s.length) error("存在未解析的内容");
  return out;
}
