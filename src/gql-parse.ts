// A small GraphQL parser for the document shapes gh and github-mcp-server send:
// named queries and mutations, variable definitions, aliases, inline fragments,
// and argument values that are variables, strings, ints, enums, booleans, null,
// lists or input objects. It builds an AST only — execution lives in graphql.ts.

export type Value =
  | { kind: 'var'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'enum'; value: string }
  | { kind: 'bool'; value: boolean }
  | { kind: 'null' }
  | { kind: 'list'; items: Value[] }
  | { kind: 'object'; fields: Array<[string, Value]> };

export interface FieldNode {
  alias: string | null;
  name: string;
  args: Array<[string, Value]>;
  selection: SelectionNode[] | null;
}

export type SelectionNode =
  | { kind: 'field'; field: FieldNode }
  | { kind: 'fragment'; typeCondition: string; selection: SelectionNode[] };

export interface Operation {
  type: 'query' | 'mutation';
  name: string | null;
  selection: SelectionNode[];
}

interface Token {
  kind: 'name' | 'string' | 'int' | 'float' | 'punct' | 'spread' | 'eof';
  value: string;
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (c: string): boolean => /[A-Za-z_]/.test(c);
  const isNameChar = (c: string): boolean => /[A-Za-z0-9_]/.test(c);
  while (i < source.length) {
    const c = source[i] as string;
    if (c === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',') {
      i += 1;
      continue;
    }
    if (source.startsWith('...', i)) {
      tokens.push({ kind: 'spread', value: '...' });
      i += 3;
      continue;
    }
    if ('{}()[]:$!@='.includes(c)) {
      tokens.push({ kind: 'punct', value: c });
      i += 1;
      continue;
    }
    if (c === '"') {
      if (source.startsWith('"""', i)) {
        const end = source.indexOf('"""', i + 3);
        if (end === -1) throw new Error('unterminated block string');
        tokens.push({ kind: 'string', value: source.slice(i + 3, end) });
        i = end + 3;
        continue;
      }
      let j = i + 1;
      let out = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\') {
          const esc = source[j + 1] as string;
          out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          j += 2;
        } else {
          out += source[j];
          j += 1;
        }
      }
      if (j >= source.length) throw new Error('unterminated string');
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (isNameStart(c)) {
      let j = i;
      while (j < source.length && isNameChar(source[j] as string)) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    if (/[0-9-]/.test(c)) {
      let j = i;
      while (j < source.length && /[0-9.eE+-]/.test(source[j] as string)) j += 1;
      const text = source.slice(i, j);
      tokens.push({ kind: /[.eE]/.test(text) ? 'float' : 'int', value: text });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(c)} in the GraphQL document`);
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

class Parser {
  private tokens: Token[];
  private pos = 0;

  constructor(source: string) {
    this.tokens = tokenize(source);
  }

  private peek(): Token {
    return this.tokens[this.pos] as Token;
  }

  private next(): Token {
    const token = this.tokens[this.pos] as Token;
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) {
      throw new Error(`expected ${value}, found ${token.value || token.kind}`);
    }
  }

  private skipPunct(value: string): boolean {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === value) {
      this.pos += 1;
      return true;
    }
    return false;
  }

  parseDocument(): Operation[] {
    const operations: Operation[] = [];
    while (this.peek().kind !== 'eof') {
      operations.push(this.parseOperation());
    }
    if (operations.length === 0) throw new Error('the document holds no operation');
    return operations;
  }

  private parseOperation(): Operation {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === '{') {
      return { type: 'query', name: null, selection: this.parseSelectionSet() };
    }
    if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
      this.next();
      let name: string | null = null;
      if (this.peek().kind === 'name') name = this.next().value;
      if (this.peek().kind === 'punct' && this.peek().value === '(') this.parseVariableDefinitions();
      // Directives are not used by the clients this serves; skip any that appear.
      while (this.peek().kind === 'punct' && this.peek().value === '@') {
        this.next();
        this.next();
        if (this.peek().kind === 'punct' && this.peek().value === '(') this.parseArguments();
      }
      return { type: token.value as 'query' | 'mutation', name, selection: this.parseSelectionSet() };
    }
    throw new Error(`expected an operation, found ${token.value || token.kind}`);
  }

  private parseVariableDefinitions(): void {
    this.expectPunct('(');
    while (!this.skipPunct(')')) {
      this.expectPunct('$');
      const nameToken = this.next();
      if (nameToken.kind !== 'name') throw new Error('a variable definition needs a name');
      this.expectPunct(':');
      this.parseType();
      if (this.skipPunct('=')) this.parseValue();
    }
  }

  private parseType(): void {
    if (this.skipPunct('[')) {
      this.parseType();
      this.expectPunct(']');
    } else {
      const token = this.next();
      if (token.kind !== 'name') throw new Error('a type needs a name');
    }
    this.skipPunct('!');
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!this.skipPunct('}')) {
      if (this.peek().kind === 'spread') {
        this.next();
        const on = this.next();
        if (on.kind !== 'name' || on.value !== 'on') throw new Error('only inline fragments are supported');
        const typeToken = this.next();
        if (typeToken.kind !== 'name') throw new Error('an inline fragment needs a type condition');
        selections.push({ kind: 'fragment', typeCondition: typeToken.value, selection: this.parseSelectionSet() });
        continue;
      }
      selections.push({ kind: 'field', field: this.parseField() });
    }
    return selections;
  }

  private parseField(): FieldNode {
    const first = this.next();
    if (first.kind !== 'name') throw new Error('a field needs a name');
    let alias: string | null = null;
    let name = first.value;
    if (this.skipPunct(':')) {
      alias = name;
      const nameToken = this.next();
      if (nameToken.kind !== 'name') throw new Error('an aliased field needs a name');
      name = nameToken.value;
    }
    let args: Array<[string, Value]> = [];
    if (this.peek().kind === 'punct' && this.peek().value === '(') args = this.parseArguments();
    let selection: SelectionNode[] | null = null;
    if (this.peek().kind === 'punct' && this.peek().value === '{') selection = this.parseSelectionSet();
    return { alias, name, args, selection };
  }

  private parseArguments(): Array<[string, Value]> {
    this.expectPunct('(');
    const args: Array<[string, Value]> = [];
    while (!this.skipPunct(')')) {
      const nameToken = this.next();
      if (nameToken.kind !== 'name') throw new Error('an argument needs a name');
      this.expectPunct(':');
      args.push([nameToken.value, this.parseValue()]);
    }
    return args;
  }

  private parseValue(): Value {
    const token = this.next();
    switch (token.kind) {
      case 'punct': {
        if (token.value === '$') {
          const nameToken = this.next();
          if (nameToken.kind !== 'name') throw new Error('a variable reference needs a name');
          return { kind: 'var', name: nameToken.value };
        }
        if (token.value === '[') {
          const items: Value[] = [];
          while (!this.skipPunct(']')) items.push(this.parseValue());
          return { kind: 'list', items };
        }
        if (token.value === '{') {
          const fields: Array<[string, Value]> = [];
          while (!this.skipPunct('}')) {
            const nameToken = this.next();
            if (nameToken.kind !== 'name') throw new Error('an input object field needs a name');
            this.expectPunct(':');
            fields.push([nameToken.value, this.parseValue()]);
          }
          return { kind: 'object', fields };
        }
        throw new Error(`unexpected ${token.value} in a value`);
      }
      case 'string':
        return { kind: 'string', value: token.value };
      case 'int':
        return { kind: 'int', value: Number.parseInt(token.value, 10) };
      case 'float':
        return { kind: 'float', value: Number.parseFloat(token.value) };
      case 'name': {
        if (token.value === 'true') return { kind: 'bool', value: true };
        if (token.value === 'false') return { kind: 'bool', value: false };
        if (token.value === 'null') return { kind: 'null' };
        return { kind: 'enum', value: token.value };
      }
      default:
        throw new Error('unexpected token in a value');
    }
  }
}

/** Parse a GraphQL document into its operations; throws on malformed input. */
export function parseGraphQL(source: string): Operation[] {
  return new Parser(source).parseDocument();
}

/** Resolve an argument Value against the operation's variables into plain JS data. */
export function resolveValue(value: Value, variables: Record<string, unknown>): unknown {
  switch (value.kind) {
    case 'var':
      return variables[value.name];
    case 'string':
    case 'int':
    case 'float':
    case 'bool':
    case 'enum':
      return value.value;
    case 'null':
      return null;
    case 'list':
      return value.items.map((item) => resolveValue(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, fieldValue] of value.fields) out[key] = resolveValue(fieldValue, variables);
      return out;
    }
  }
}
