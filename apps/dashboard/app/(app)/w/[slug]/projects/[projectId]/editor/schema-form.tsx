'use client';
/**
 * P3 S3 (FR-BLD-01): a form generated from a block's JSON Schema (made on the server from the Zod schemas in
 * @platform/schema, so it cannot drift from them). It covers the shapes the block catalogue uses: text, choice lists,
 * switches, numbers, nested groups, lists and plain rich text. The server re-validates every save with the full Zod
 * schema; this form only shapes the input and shows the server's field errors next to the right field.
 */
import { useId, type ReactNode } from 'react';

export interface JsonSchema {
  type?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: readonly string[];
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  const?: unknown;
  maxLength?: number;
  minLength?: number;
  maxItems?: number;
  minimum?: number;
  maximum?: number;
}

export type FieldErrors = Record<string, string>;
type Value = unknown;

const ACRONYMS: Record<string, string> = { cta: 'CTA', seo: 'SEO', url: 'URL', id: 'ID', og: 'OG' };

/** `primaryCta` → "Primary CTA". Labels come from the schema's property names. */
export function humanize(key: string): string {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[-_]/g, ' ')
    .split(' ')
    .filter(Boolean)
    .map((w) => ACRONYMS[w.toLowerCase()] ?? w.toLowerCase());
  const first = words[0] ?? key;
  return [first.charAt(0).toUpperCase() + first.slice(1), ...words.slice(1)].join(' ');
}

type Kind = 'string' | 'enum' | 'boolean' | 'number' | 'object' | 'array' | 'rich' | 'unsupported';

/** Several string alternatives (internal path, anchor, external URL) are one text field. */
function stringAlternatives(schema: JsonSchema): JsonSchema | null {
  const options = (schema.anyOf ?? []).filter((o) => o.const !== '');
  return options.length > 0 && options.every((o) => o.type === 'string') ? options[0]! : null;
}

function isRichText(schema: JsonSchema): boolean {
  return (
    schema.type === 'array' && (schema.items?.oneOf ?? []).some((o) => o.properties?.type?.const === 'text')
  );
}

export function kindOf(schema: JsonSchema): Kind {
  if (schema.enum) return 'enum';
  if (isRichText(schema)) return 'rich';
  if (schema.anyOf) return stringAlternatives(schema) ? 'string' : 'unsupported';
  switch (schema.type) {
    case 'string':
      return 'string';
    case 'boolean':
      return 'boolean';
    case 'number':
    case 'integer':
      return 'number';
    case 'object':
      return 'object';
    case 'array':
      return 'array';
    default:
      return 'unsupported';
  }
}

/** A starting value for a new list item or an optional group the person adds. */
export function defaultFor(schema: JsonSchema): Value {
  switch (kindOf(schema)) {
    case 'enum':
      return schema.enum![0];
    case 'boolean':
      return false;
    case 'number':
      return schema.minimum ?? 0;
    case 'array':
    case 'rich':
      return [];
    case 'object': {
      const out: Record<string, Value> = {};
      for (const key of schema.required ?? []) out[key] = defaultFor(schema.properties![key]!);
      return out;
    }
    default:
      return '';
  }
}

type RichNode =
  { type: 'text'; text: string; bold?: boolean; italic?: boolean } | { type: 'link' } | { type: 'br' };

/** Plain text if the rich text has no formatting (bold, italic, links); otherwise null (shown read-only for now). */
function richToPlain(nodes: unknown): string | null {
  if (!Array.isArray(nodes)) return '';
  let out = '';
  for (const node of nodes as RichNode[]) {
    if (node.type === 'br') out += '\n';
    else if (node.type === 'text' && !node.bold && !node.italic) out += node.text;
    else return null;
  }
  return out;
}

function plainToRich(text: string): RichNode[] {
  const lines = text.split('\n');
  return lines.flatMap((line, i): RichNode[] => [
    ...(line ? [{ type: 'text' as const, text: line }] : []),
    ...(i < lines.length - 1 ? [{ type: 'br' as const }] : []),
  ]);
}

const inputClass =
  'block w-full rounded-[var(--radius-base)] border border-slate-300 bg-white px-3 py-2 text-sm shadow-xs outline-none focus:border-[var(--color-primary)] focus:ring-2 focus:ring-[var(--color-primary)]/20 disabled:bg-slate-50 aria-[invalid=true]:border-red-500';
const smallButton =
  'rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium hover:bg-slate-50 disabled:opacity-50';

function Label({ htmlFor, required, children }: { htmlFor: string; required: boolean; children: ReactNode }) {
  return (
    <label htmlFor={htmlFor} className="block text-sm font-medium">
      {children}
      {required ? null : <span className="ml-1 font-normal text-slate-500">(optional)</span>}
    </label>
  );
}

function ErrorText({ id, message }: { id: string; message?: string }) {
  return message ? (
    <p id={id} className="text-xs text-red-700">
      {message}
    </p>
  ) : null;
}

export function SchemaField({
  schema,
  value,
  onChange,
  label,
  path,
  required,
  errors,
  disabled,
}: {
  schema: JsonSchema;
  value: Value;
  onChange: (value: Value) => void;
  label: string;
  /** Dotted path from the form root (`items.0.title`), matched against the server's field errors. */
  path: string;
  required: boolean;
  errors: FieldErrors;
  disabled: boolean;
}) {
  const id = `f-${useId().replace(/[^a-zA-Z0-9-]/g, '')}`;
  const error = errors[path];
  const errorId = `${id}-error`;
  const common = {
    id,
    disabled,
    'aria-invalid': error ? true : undefined,
    'aria-describedby': error ? errorId : undefined,
  } as const;

  switch (kindOf(schema)) {
    case 'string': {
      const base = stringAlternatives(schema) ?? schema;
      const long = (base.maxLength ?? 0) > 200;
      const text = typeof value === 'string' ? value : '';
      const set = (v: string) => onChange(v === '' && !required ? undefined : v);
      return (
        <div className="space-y-1">
          <Label htmlFor={id} required={required}>
            {label}
          </Label>
          {long ? (
            <textarea
              {...common}
              rows={3}
              maxLength={base.maxLength}
              className={inputClass}
              value={text}
              onChange={(e) => set(e.target.value)}
            />
          ) : (
            <input
              {...common}
              type="text"
              maxLength={base.maxLength}
              className={inputClass}
              value={text}
              onChange={(e) => set(e.target.value)}
            />
          )}
          <ErrorText id={errorId} message={error} />
        </div>
      );
    }
    case 'enum':
      return (
        <div className="space-y-1">
          <Label htmlFor={id} required={required}>
            {label}
          </Label>
          <select
            {...common}
            className={inputClass}
            value={typeof value === 'string' ? value : ''}
            onChange={(e) => onChange(e.target.value === '' ? undefined : e.target.value)}
          >
            {required ? null : <option value="">None</option>}
            {schema.enum!.map((option) => (
              <option key={option} value={option}>
                {humanize(option)}
              </option>
            ))}
          </select>
          <ErrorText id={errorId} message={error} />
        </div>
      );
    case 'boolean':
      return (
        <div className="flex items-center gap-2">
          <input
            {...common}
            type="checkbox"
            className="size-4"
            checked={value === true}
            onChange={(e) => onChange(e.target.checked)}
          />
          <label htmlFor={id} className="text-sm">
            {label}
          </label>
          <ErrorText id={errorId} message={error} />
        </div>
      );
    case 'number':
      return (
        <div className="space-y-1">
          <Label htmlFor={id} required={required}>
            {label}
          </Label>
          <input
            {...common}
            type="number"
            min={schema.minimum}
            max={schema.maximum}
            className={inputClass}
            value={typeof value === 'number' ? value : ''}
            onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))}
          />
          <ErrorText id={errorId} message={error} />
        </div>
      );
    case 'rich': {
      const plain = richToPlain(value);
      return (
        <div className="space-y-1">
          <Label htmlFor={id} required={required}>
            {label}
          </Label>
          {plain === null ? (
            <div className="space-y-2 rounded-md border border-dashed border-slate-300 p-3 text-sm text-slate-600">
              <p id={id}>
                This text has formatting (bold, italic or links), which this editor cannot change yet.
              </p>
              <button
                type="button"
                className={smallButton}
                disabled={disabled}
                onClick={() => onChange(plainToRich(textOf(value)))}
              >
                Replace with plain text
              </button>
            </div>
          ) : (
            <textarea
              {...common}
              rows={5}
              className={inputClass}
              value={plain}
              onChange={(e) => onChange(plainToRich(e.target.value))}
            />
          )}
          <ErrorText id={errorId} message={error} />
        </div>
      );
    }
    case 'object': {
      const obj = value && typeof value === 'object' ? (value as Record<string, Value>) : undefined;
      if (!obj) {
        return (
          <div className="flex items-center justify-between gap-3 rounded-md border border-dashed border-slate-300 p-3">
            <span className="text-sm text-slate-600">{label}: not set</span>
            <button
              type="button"
              className={smallButton}
              disabled={disabled}
              onClick={() => onChange(defaultFor(schema))}
            >
              Add {label.toLowerCase()}
            </button>
          </div>
        );
      }
      return (
        <fieldset className="space-y-3 rounded-md border border-slate-200 p-3">
          <legend className="px-1 text-sm font-semibold">{label}</legend>
          {Object.entries(schema.properties ?? {}).map(([key, child]) => (
            <SchemaField
              key={key}
              schema={child}
              value={obj[key]}
              onChange={(v) => {
                const next = { ...obj };
                if (v === undefined) delete next[key];
                else next[key] = v;
                onChange(next);
              }}
              label={humanize(key)}
              path={path ? `${path}.${key}` : key}
              required={(schema.required ?? []).includes(key)}
              errors={errors}
              disabled={disabled}
            />
          ))}
          {required ? null : (
            <button
              type="button"
              className={smallButton}
              disabled={disabled}
              onClick={() => onChange(undefined)}
            >
              Remove {label.toLowerCase()}
            </button>
          )}
          <ErrorText id={errorId} message={error} />
        </fieldset>
      );
    }
    case 'array': {
      const list = Array.isArray(value) ? value : [];
      const item = schema.items ?? {};
      const full = schema.maxItems !== undefined && list.length >= schema.maxItems;
      const move = (from: number, to: number) => {
        const next = [...list];
        const [moved] = next.splice(from, 1);
        next.splice(to, 0, moved);
        onChange(next);
      };
      return (
        <fieldset className="space-y-3 rounded-md border border-slate-200 p-3">
          <legend className="px-1 text-sm font-semibold">
            {label} <span className="font-normal text-slate-500">({list.length})</span>
          </legend>
          {list.map((entry, i) => (
            <div key={i} className="space-y-2 border-b border-slate-100 pb-3 last:border-b-0">
              <SchemaField
                schema={item}
                value={entry}
                onChange={(v) => onChange(list.map((e, j) => (j === i ? v : e)))}
                label={`${label} ${i + 1}`}
                path={`${path}.${i}`}
                required
                errors={errors}
                disabled={disabled}
              />
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  className={smallButton}
                  disabled={disabled || i === 0}
                  onClick={() => move(i, i - 1)}
                >
                  Move up
                  <span className="sr-only">
                    : {label} {i + 1}
                  </span>
                </button>
                <button
                  type="button"
                  className={smallButton}
                  disabled={disabled || i === list.length - 1}
                  onClick={() => move(i, i + 1)}
                >
                  Move down
                  <span className="sr-only">
                    : {label} {i + 1}
                  </span>
                </button>
                <button
                  type="button"
                  className={smallButton}
                  disabled={disabled}
                  onClick={() => onChange(list.filter((_, j) => j !== i))}
                >
                  Remove
                  <span className="sr-only">
                    : {label} {i + 1}
                  </span>
                </button>
              </div>
            </div>
          ))}
          <button
            type="button"
            className={smallButton}
            disabled={disabled || full}
            onClick={() => onChange([...list, defaultFor(item)])}
          >
            Add to {label.toLowerCase()}
          </button>
          <ErrorText id={errorId} message={error} />
        </fieldset>
      );
    }
    default:
      return <p className="text-sm text-slate-500">{label}: edited in a later version of the editor.</p>;
  }
}

function textOf(nodes: unknown): string {
  if (!Array.isArray(nodes)) return '';
  return (nodes as Array<{ type: string; text?: string }>)
    .map((n) => (n.type === 'br' ? '\n' : (n.text ?? '')))
    .join('');
}
