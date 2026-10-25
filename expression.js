(function () {
  "use strict";

  class ExpressionError extends Error {
    constructor(message, position = null) {
      super(message);
      this.name = "ExpressionError";
      this.position = position;
    }
  }

  const BINARY_PRECEDENCE = {
    "+": 1,
    "-": 1,
    "*": 2,
    "/": 2,
    "^": 4,
  };

  const UNARY_PRECEDENCE = 3;

  const FUNCTIONS = {
    sin: { min: 1, max: 1, fn: Math.sin },
    cos: { min: 1, max: 1, fn: Math.cos },
    tan: { min: 1, max: 1, fn: Math.tan },
    asin: { min: 1, max: 1, fn: Math.asin },
    acos: { min: 1, max: 1, fn: Math.acos },
    atan: { min: 1, max: 1, fn: Math.atan },
    sinh: { min: 1, max: 1, fn: Math.sinh },
    cosh: { min: 1, max: 1, fn: Math.cosh },
    tanh: { min: 1, max: 1, fn: Math.tanh },
    sqrt: { min: 1, max: 1, fn: Math.sqrt },
    abs: { min: 1, max: 1, fn: Math.abs },
    exp: { min: 1, max: 1, fn: Math.exp },
    ln: { min: 1, max: 1, fn: Math.log },
    log: { min: 1, max: 1, fn: Math.log },
    log10: { min: 1, max: 1, fn: Math.log10 },
    lg: { min: 1, max: 1, fn: Math.log10 },
    floor: { min: 1, max: 1, fn: Math.floor },
    ceil: { min: 1, max: 1, fn: Math.ceil },
    round: { min: 1, max: 1, fn: Math.round },
    sign: { min: 1, max: 1, fn: Math.sign },
    min: { min: 1, max: Infinity, fn: Math.min },
    max: { min: 1, max: Infinity, fn: Math.max },
    pow: { min: 2, max: 2, fn: Math.pow },
    atan2: { min: 2, max: 2, fn: Math.atan2 },
    sec: { min: 1, max: 1, fn: (value) => 1 / Math.cos(value) },
    csc: { min: 1, max: 1, fn: (value) => 1 / Math.sin(value) },
    cot: { min: 1, max: 1, fn: (value) => 1 / Math.tan(value) },
  };

  const CONSTANTS = {
    e: Math.E,
    pi: Math.PI,
  };

  function normalizeExpression(raw) {
    let source = String(raw ?? "")
      .replace(/（/g, "(")
      .replace(/）/g, ")")
      .replace(/，/g, ",")
      .replace(/[−–—]/g, "-")
      .replace(/[×·]/g, "*")
      .replace(/÷/g, "/")
      .replace(/π/g, "pi")
      .replace(/√\s*\(/g, "sqrt(")
      .replace(/²/g, "^2")
      .replace(/³/g, "^3")
      .replace(/\*\*/g, "^")
      .trim();

    source = source.replace(/^(?:y|f\s*\(\s*x\s*\))\s*=\s*/i, "").trim();
    return source;
  }

  function tokenize(source) {
    const tokens = [];
    let index = 0;

    while (index < source.length) {
      const character = source[index];

      if (/\s/.test(character)) {
        index += 1;
        continue;
      }

      if (/[0-9.]/.test(character)) {
        const match = source
          .slice(index)
          .match(/^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/);

        if (!match) {
          throw new ExpressionError(`无法识别数字“${character}”`, index);
        }

        if (source[index + match[0].length] === ".") {
          throw new ExpressionError("数字的小数点格式不正确", index);
        }

        tokens.push({
          type: "number",
          value: Number(match[0]),
          position: index,
        });
        index += match[0].length;
        continue;
      }

      if (/[A-Za-z]/.test(character)) {
        const match = source.slice(index).match(/^[A-Za-z]+/);
        tokens.push({
          type: "name",
          value: match[0].toLowerCase(),
          position: index,
        });
        index += match[0].length;
        continue;
      }

      if (BINARY_PRECEDENCE[character]) {
        tokens.push({
          type: "operator",
          value: character,
          position: index,
        });
        index += 1;
        continue;
      }

      if (character === "(" || character === ")" || character === ",") {
        tokens.push({
          type: character,
          value: character,
          position: index,
        });
        index += 1;
        continue;
      }

      throw new ExpressionError(`无法识别字符“${character}”`, index);
    }

    tokens.push({
      type: "eof",
      value: "",
      position: source.length,
    });

    return tokens;
  }

  class Parser {
    constructor(source) {
      this.source = source;
      this.tokens = tokenize(source);
      this.index = 0;
    }

    peek() {
      return this.tokens[this.index];
    }

    advance() {
      const token = this.peek();
      this.index += 1;
      return token;
    }

    parse() {
      const expression = this.parseExpression(0);
      const trailing = this.peek();

      if (trailing.type !== "eof") {
        throw new ExpressionError(
          `这里多了一个“${trailing.value}”`,
          trailing.position,
        );
      }

      return expression;
    }

    parseExpression(minimumPrecedence) {
      let left = this.parseUnary();

      while (true) {
        const next = this.peek();
        let operator = null;
        let implicit = false;
        let position = next.position;

        if (next.type === "operator" && BINARY_PRECEDENCE[next.value]) {
          operator = next.value;
        } else if (
          next.type === "name" ||
          next.type === "number" ||
          next.type === "("
        ) {
          operator = "*";
          implicit = true;
        } else {
          break;
        }

        const precedence = BINARY_PRECEDENCE[operator];

        if (precedence < minimumPrecedence) {
          break;
        }

        if (!implicit) {
          this.advance();
        }

        const nextPrecedence =
          operator === "^" ? precedence : precedence + 1;
        const right = this.parseExpression(nextPrecedence);

        left = {
          type: "binary",
          operator,
          left,
          right,
          position,
        };
      }

      return left;
    }

    parseUnary() {
      const token = this.peek();

      if (
        token.type === "operator" &&
        (token.value === "+" || token.value === "-")
      ) {
        this.advance();
        return {
          type: "unary",
          operator: token.value,
          value: this.parseExpression(UNARY_PRECEDENCE),
          position: token.position,
        };
      }

      return this.parsePrimary();
    }

    parsePrimary() {
      const token = this.peek();

      if (token.type === "number") {
        this.advance();
        return {
          type: "number",
          value: token.value,
          position: token.position,
        };
      }

      if (token.type === "name") {
        this.advance();
        const name = token.value;

        if (this.peek().type === "(") {
          if (!FUNCTIONS[name]) {
            throw new ExpressionError(`未知函数“${name}”`, token.position);
          }
          return this.parseFunctionCall(name, token.position);
        }

        if (name === "x") {
          return { type: "variable", position: token.position };
        }

        if (Object.hasOwn(CONSTANTS, name)) {
          return {
            type: "number",
            value: CONSTANTS[name],
            position: token.position,
          };
        }

        if (FUNCTIONS[name]) {
          const requirement =
            FUNCTIONS[name].max === 1 ? "一个参数" : "两个参数";
          throw new ExpressionError(
            `函数“${name}”后面需要括号和${requirement}`,
            token.position,
          );
        }

        throw new ExpressionError(`未知符号“${name}”`, token.position);
      }

      if (token.type === "(") {
        this.advance();
        const expression = this.parseExpression(0);

        if (this.peek().type !== ")") {
          throw new ExpressionError("这里缺少右括号", this.peek().position);
        }

        this.advance();
        return expression;
      }

      if (token.type === "eof") {
        throw new ExpressionError("表达式还没有写完", token.position);
      }

      throw new ExpressionError(
        `这里不能使用“${token.value}”`,
        token.position,
      );
    }

    parseFunctionCall(name, position) {
      this.advance();
      const args = [];

      if (this.peek().type === ")") {
        this.advance();
        throw new ExpressionError(`函数“${name}”缺少参数`, position);
      }

      while (true) {
        args.push(this.parseExpression(0));

        if (this.peek().type === ",") {
          this.advance();
          continue;
        }

        if (this.peek().type === ")") {
          this.advance();
          break;
        }

        throw new ExpressionError(
          "函数参数之间缺少逗号或右括号",
          this.peek().position,
        );
      }

      const spec = FUNCTIONS[name];

      if (args.length < spec.min || args.length > spec.max) {
        const expected =
          spec.min === spec.max
            ? `${spec.min} 个参数`
            : `至少 ${spec.min} 个参数`;
        throw new ExpressionError(
          `函数“${name}”需要${expected}`,
          position,
        );
      }

      return {
        type: "call",
        name,
        args,
        position,
      };
    }
  }

  function evaluateNode(node, x) {
    switch (node.type) {
      case "number":
        return node.value;
      case "variable":
        return x;
      case "unary": {
        const value = evaluateNode(node.value, x);
        return node.operator === "-" ? -value : value;
      }
      case "binary": {
        const left = evaluateNode(node.left, x);
        const right = evaluateNode(node.right, x);

        switch (node.operator) {
          case "+":
            return left + right;
          case "-":
            return left - right;
          case "*":
            return left * right;
          case "/":
            return left / right;
          case "^":
            return Math.pow(left, right);
          default:
            return Number.NaN;
        }
      }
      case "call": {
        const args = node.args.map((arg) => evaluateNode(arg, x));
        return FUNCTIONS[node.name].fn(...args);
      }
      default:
        return Number.NaN;
    }
  }

  function compile(raw) {
    const source = normalizeExpression(raw);

    if (!source) {
      throw new ExpressionError("先输入一个函数，例如 sin(x)");
    }

    if (source.length > 200) {
      throw new ExpressionError("表达式太长，请精简到 200 个字符以内");
    }

    const ast = new Parser(source).parse();

    return {
      ast,
      source,
      evaluate(x) {
        return evaluateNode(ast, x);
      },
    };
  }

  window.FunctionPlot = {
    compile,
    ExpressionError,
    normalizeExpression,
  };
})();
