'use client';
/**
 * P3 S6 (FR-BLD-05): the project's image library in the editor.
 *
 *   - Upload: the browser checks the type and size for a quick answer, asks the server for a signed URL, sends the
 *     file straight to storage, then asks the server to check and process it (WebP widths, no metadata). The server
 *     decides; a refused file shows the server's reason.
 *   - The "Images" panel lists the library: default alt text (what a new use of the image starts with) and delete
 *     (hides it from the library; pages that use it keep it).
 *   - Image fields in the forms show the chosen image with its own alt text, and "Choose image" opens the library.
 * Uploading and describing need edit rights but not the edit lock (they do not change the site); putting an image
 * on the page is a normal draft change and does.
 */
import {
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  cropAssetAction,
  describeAssetAction,
  finishAssetUploadAction,
  hideAssetAction,
  listAssetsAction,
  requestAssetUploadAction,
} from '@/app/actions/assets';
import { type AssetView, UPLOAD_RULES } from '@/lib/asset-types';

export interface ImageRef {
  assetId: string;
  alt: string;
}

interface Library {
  assets: AssetView[];
  loaded: boolean;
  /** Uploads are configured in this environment. */
  enabled: boolean;
  /** May upload, describe and delete (owner, admin, editor in a writable workspace). */
  canManage: boolean;
  find: (assetId: string) => AssetView | undefined;
  upload: (file: File) => Promise<{ ok: true; asset: AssetView } | { ok: false; error: string }>;
  describe: (assetId: string, alt: string) => Promise<string | null>;
  hide: (assetId: string) => Promise<string | null>;
  /** S6 part 2: a new image cut from this one. */
  crop: (
    assetId: string,
    shape: { aspect: CropAspect; x: number; y: number },
  ) => Promise<{ ok: true; asset: AssetView } | { ok: false; error: string }>;
}

/** Approved 2026-11-15: the crop shapes, with the CSS ratio for the live preview. */
export const CROP_SHAPES = [
  { aspect: '1:1', label: 'Square (1:1)', css: '1 / 1' },
  { aspect: '4:3', label: 'Standard (4:3)', css: '4 / 3' },
  { aspect: '16:9', label: 'Wide (16:9)', css: '16 / 9' },
] as const;
export type CropAspect = (typeof CROP_SHAPES)[number]['aspect'];

const LibraryContext = createContext<Library | null>(null);

export function useLibrary(): Library | null {
  return useContext(LibraryContext);
}

export function AssetLibraryProvider({
  target,
  enabled,
  canManage,
  children,
}: {
  target: { workspaceId: string; projectId: string };
  enabled: boolean;
  canManage: boolean;
  children: ReactNode;
}) {
  const [assets, setAssets] = useState<AssetView[]>([]);
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(async () => {
    const result = await listAssetsAction(target);
    if (result.ok) setAssets(result.value);
    setLoaded(true);
  }, [target]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const upload = useCallback<Library['upload']>(
    async (file) => {
      if (!(UPLOAD_RULES.types as readonly string[]).includes(file.type)) {
        return {
          ok: false,
          error: 'Only JPEG, PNG and WebP photos can be used. Save it as a JPEG and try again.',
        };
      }
      if (file.size > UPLOAD_RULES.maxBytes) return { ok: false, error: 'This file is larger than 10 MB.' };
      if (file.size === 0) return { ok: false, error: 'This file is empty.' };
      const started = await requestAssetUploadAction({
        ...target,
        fileName: file.name,
        contentType: file.type,
        size: file.size,
      });
      if (!started.ok)
        return { ok: false, error: Object.values(started.fieldErrors ?? {})[0] ?? started.error };
      const put = await fetch(started.value.upload.url, {
        method: 'PUT',
        headers: started.value.upload.headers,
        body: file,
      }).catch(() => null);
      if (!put?.ok)
        return { ok: false, error: 'The upload did not finish. Check your connection and try again.' };
      const done = await finishAssetUploadAction({ ...target, assetId: started.value.assetId });
      if (!done.ok) return { ok: false, error: done.error };
      if (done.value.status !== 'ready') {
        return { ok: false, error: done.value.rejectMessage ?? 'This file could not be used.' };
      }
      setAssets((list) => [done.value, ...list.filter((a) => a.id !== done.value.id)]);
      return { ok: true, asset: done.value };
    },
    [target],
  );

  const describe = useCallback<Library['describe']>(
    async (assetId, alt) => {
      const result = await describeAssetAction({ ...target, assetId, alt });
      if (!result.ok) return Object.values(result.fieldErrors ?? {})[0] ?? result.error;
      setAssets((list) => list.map((a) => (a.id === assetId ? result.value : a)));
      return null;
    },
    [target],
  );

  const hide = useCallback<Library['hide']>(
    async (assetId) => {
      const result = await hideAssetAction({ ...target, assetId });
      if (!result.ok) return result.error;
      // Kept in memory: a page that uses it still shows its thumbnail in the form.
      setAssets((list) => list.filter((a) => a.id !== assetId));
      return null;
    },
    [target],
  );

  const crop = useCallback<Library['crop']>(
    async (assetId, shape) => {
      const result = await cropAssetAction({ ...target, assetId, ...shape });
      if (!result.ok) return { ok: false, error: Object.values(result.fieldErrors ?? {})[0] ?? result.error };
      if (result.value.status !== 'ready') {
        return { ok: false, error: result.value.rejectMessage ?? 'This crop could not be made.' };
      }
      setAssets((list) => [result.value, ...list]);
      return { ok: true, asset: result.value };
    },
    [target],
  );

  // Hidden images used on a page are not in the list; the form still needs their thumbnail. Remember everything
  // this session has seen.
  const seen = useRef(new Map<string, AssetView>());
  for (const a of assets) seen.current.set(a.id, a);
  const value = useMemo<Library>(
    () => ({
      assets,
      loaded,
      enabled,
      canManage,
      find: (id) => seen.current.get(id),
      upload,
      describe,
      hide,
      crop,
    }),
    [assets, loaded, enabled, canManage, upload, describe, hide, crop],
  );
  return <LibraryContext.Provider value={value}>{children}</LibraryContext.Provider>;
}

const button =
  'rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium hover:bg-slate-50 disabled:opacity-50';
const primary =
  'rounded-md bg-[var(--color-primary)] px-3 py-1.5 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50';

function Thumb({ asset, size = 'h-20 w-28' }: { asset: AssetView | undefined; size?: string }) {
  if (!asset?.thumbnailUrl) {
    return (
      <div
        className={`${size} flex items-center justify-center rounded border border-dashed border-slate-300 bg-slate-50 text-center text-xs text-slate-600`}
      >
        No preview
      </div>
    );
  }
  return (
    <img src={asset.thumbnailUrl} alt="" className={`${size} rounded border border-slate-200 object-cover`} />
  );
}

/** An upload button that reports progress and the server's answer. */
function UploadButton({
  onUploaded,
  disabled,
}: {
  onUploaded?: (asset: AssetView) => void;
  disabled: boolean;
}) {
  const library = useLibrary();
  const inputId = `upload-${useId().replace(/[^a-zA-Z0-9-]/g, '')}`;
  const [state, setState] = useState<{ busy: boolean; message: string; error: boolean }>({
    busy: false,
    message: '',
    error: false,
  });
  if (!library) return null;
  if (!library.enabled) {
    return <p className="text-sm text-slate-600">Image uploads are not set up in this environment yet.</p>;
  }
  const onFiles = async (files: FileList | null) => {
    const file = files?.[0];
    if (!file) return;
    setState({ busy: true, message: `Uploading ${file.name}…`, error: false });
    const result = await library.upload(file);
    if (result.ok) {
      setState({ busy: false, message: `${result.asset.fileName} is ready.`, error: false });
      onUploaded?.(result.asset);
    } else setState({ busy: false, message: result.error, error: true });
  };
  return (
    <div className="space-y-1">
      <label
        htmlFor={inputId}
        className={`${primary} inline-block cursor-pointer ${disabled || state.busy ? 'pointer-events-none opacity-50' : ''}`}
      >
        {state.busy ? 'Uploading…' : 'Upload image'}
      </label>
      <input
        id={inputId}
        type="file"
        accept={UPLOAD_RULES.accept}
        className="sr-only"
        disabled={disabled || state.busy}
        onChange={(e) => {
          void onFiles(e.target.files);
          e.target.value = '';
        }}
      />
      <p className="text-xs text-slate-600">JPEG, PNG or WebP, up to 10 MB.</p>
      <p
        role={state.error ? 'alert' : 'status'}
        className={`text-sm ${state.error ? 'text-red-700' : 'text-slate-700'}`}
      >
        {state.message}
      </p>
    </div>
  );
}

/** The library in a dialog: pick an image or upload a new one (it is picked once ready). */
export function ImagePicker({
  open,
  onClose,
  onPick,
}: {
  open: boolean;
  onClose: () => void;
  onPick: (image: ImageRef) => void;
}) {
  const library = useLibrary();
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = `picker-${useId().replace(/[^a-zA-Z0-9-]/g, '')}`;
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);
  if (!library) return null;
  const pick = (a: AssetView) => {
    // The site needs a description (alt is required): the library default, else a start from the file name.
    onPick({ assetId: a.id, alt: a.alt || altFromFileName(a.fileName) });
    onClose();
  };
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onClose={onClose}
      className="m-auto w-[min(40rem,calc(100vw-2rem))] rounded-[var(--radius-base)] border border-slate-200 p-0 shadow-xl backdrop:bg-slate-900/40"
    >
      <div className="space-y-4 p-4">
        <div className="flex items-center justify-between gap-3">
          <h2 id={titleId} className="text-base font-semibold">
            Choose an image
          </h2>
          <button type="button" className={button} onClick={onClose}>
            Close
          </button>
        </div>
        <UploadButton disabled={!library.canManage} onUploaded={pick} />
        {library.assets.length === 0 ? (
          <p className="text-sm text-slate-600">
            {!library.loaded
              ? 'Loading…'
              : library.enabled && library.canManage
                ? 'No images yet. Upload one above.'
                : 'No images yet.'}
          </p>
        ) : (
          <ul className="grid max-h-[50vh] grid-cols-2 gap-3 overflow-y-auto sm:grid-cols-3">
            {library.assets.map((a) => (
              <li key={a.id}>
                <button
                  type="button"
                  onClick={() => pick(a)}
                  className="w-full space-y-1 rounded-md border border-slate-200 p-2 text-left text-xs hover:border-[var(--color-primary)]"
                >
                  <Thumb asset={a} size="h-24 w-full" />
                  <span className="block truncate">
                    <span className="sr-only">Use </span>
                    {a.fileName}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </dialog>
  );
}

/** An image field in a form: the chosen image, its alt text (required, SRS 5.2) and change/remove. */
export function ImageField({
  label,
  value,
  onChange,
  required,
  disabled,
  error,
  altError,
  altMax,
}: {
  label: string;
  value: ImageRef | undefined;
  onChange: (value: ImageRef | undefined) => void;
  required: boolean;
  disabled: boolean;
  error?: string;
  altError?: string;
  altMax?: number;
}) {
  const library = useLibrary();
  const [open, setOpen] = useState(false);
  const altId = `alt-${useId().replace(/[^a-zA-Z0-9-]/g, '')}`;
  const asset = value ? library?.find(value.assetId) : undefined;
  return (
    <fieldset className="space-y-2 rounded-md border border-slate-200 p-3">
      <legend className="px-1 text-sm font-semibold">
        {label}
        {required ? null : <span className="ml-1 font-normal text-slate-500">(optional)</span>}
      </legend>
      {value ? (
        <>
          <div className="flex items-start gap-3">
            <Thumb asset={asset} />
            <div className="min-w-0 text-xs text-slate-600">
              {asset ? (
                <span className="block truncate">{asset.fileName}</span>
              ) : (
                <span>Placeholder image from the template. Choose one of your own.</span>
              )}
            </div>
          </div>
          <div className="space-y-1">
            <label htmlFor={altId} className="block text-sm font-medium">
              Describe the image for people who cannot see it
            </label>
            <input
              id={altId}
              type="text"
              maxLength={altMax}
              disabled={disabled}
              aria-invalid={altError ? true : undefined}
              aria-describedby={altError ? `${altId}-error` : undefined}
              className="block w-full rounded-[var(--radius-base)] border border-slate-300 bg-white px-3 py-2 text-sm aria-[invalid=true]:border-red-500"
              value={value.alt}
              onChange={(e) => onChange({ ...value, alt: e.target.value })}
            />
            {altError ? (
              <p id={`${altId}-error`} className="text-xs text-red-700">
                {altError}
              </p>
            ) : null}
          </div>
        </>
      ) : (
        <p className="text-sm text-slate-600">No image chosen.</p>
      )}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className={button}
          disabled={disabled || !library}
          onClick={() => setOpen(true)}
        >
          {value ? 'Change image' : 'Choose image'}
          <span className="sr-only">: {label}</span>
        </button>
        {value && !required ? (
          <button type="button" className={button} disabled={disabled} onClick={() => onChange(undefined)}>
            Remove image<span className="sr-only">: {label}</span>
          </button>
        ) : null}
      </div>
      {error ? <p className="text-xs text-red-700">{error}</p> : null}
      <ImagePicker
        open={open}
        onClose={() => setOpen(false)}
        onPick={(image) => onChange({ assetId: image.assetId, alt: image.alt })}
      />
    </fieldset>
  );
}

/** The "Images" panel: the whole library with default alt text and delete. */
export function LibraryPanel() {
  const library = useLibrary();
  if (!library) return null;
  return (
    <div className="space-y-4">
      <p className="text-sm text-slate-600">
        Images you upload here can be used anywhere on this site. Each photo is resized for phones and
        computers and its hidden details (such as location) are removed.
      </p>
      <UploadButton disabled={!library.canManage} />
      {library.assets.length === 0 ? (
        <p className="text-sm text-slate-600">{library.loaded ? 'No images yet.' : 'Loading…'}</p>
      ) : (
        <ul className="space-y-3" aria-label="Images in this project">
          {library.assets.map((a) => (
            <LibraryItem key={a.id} asset={a} />
          ))}
        </ul>
      )}
    </div>
  );
}

function LibraryItem({ asset }: { asset: AssetView }) {
  const library = useLibrary()!;
  const [alt, setAlt] = useState(asset.alt);
  const [message, setMessage] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [cropping, setCropping] = useState(false);
  const altId = `lib-alt-${asset.id}`;
  const save = async () => {
    if (alt.trim() === asset.alt) return;
    const error = await library.describe(asset.id, alt);
    setMessage(error ?? 'Saved.');
  };
  return (
    <li className="flex gap-3 rounded-md border border-slate-200 p-3">
      <Thumb asset={asset} />
      <div className="min-w-0 flex-1 space-y-2">
        <p className="truncate text-sm font-medium">{asset.fileName}</p>
        <p className="text-xs text-slate-600">
          {asset.width} × {asset.height} px
        </p>
        <label htmlFor={altId} className="block text-xs font-medium">
          Default description
        </label>
        <input
          id={altId}
          type="text"
          maxLength={200}
          disabled={!library.canManage}
          className="block w-full rounded-[var(--radius-base)] border border-slate-300 bg-white px-2 py-1 text-sm"
          value={alt}
          onChange={(e) => setAlt(e.target.value)}
          onBlur={() => void save()}
        />
        <div className="flex flex-wrap items-center gap-2">
          {confirming ? (
            <>
              <span className="text-xs text-slate-700">
                Remove from the library? Pages that use it keep it.
              </span>
              <button
                type="button"
                className={button}
                onClick={async () => {
                  const error = await library.hide(asset.id);
                  if (error) setMessage(error);
                }}
              >
                Yes, delete<span className="sr-only"> {asset.fileName}</span>
              </button>
              <button type="button" className={button} onClick={() => setConfirming(false)}>
                Cancel
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                className={button}
                disabled={!library.canManage}
                aria-expanded={cropping}
                onClick={() => setCropping((v) => !v)}
              >
                Crop<span className="sr-only"> {asset.fileName}</span>
              </button>
              <button
                type="button"
                className={button}
                disabled={!library.canManage}
                onClick={() => setConfirming(true)}
              >
                Delete<span className="sr-only"> {asset.fileName}</span>
              </button>
            </>
          )}
          <span role="status" className="text-xs text-slate-600">
            {message}
          </span>
        </div>
        {cropping ? (
          <CropForm
            asset={asset}
            onDone={(m) => {
              setCropping(false);
              setMessage(m);
            }}
          />
        ) : null}
      </div>
    </li>
  );
}

/**
 * S6 part 2: choose a shape and slide the frame. The preview uses CSS object-position with the same 0..100 offsets
 * the server's cropRect uses, so the picture shown is the picture made. The result is a new image in the library.
 */
function CropForm({ asset, onDone }: { asset: AssetView; onDone: (message: string) => void }) {
  const library = useLibrary()!;
  const [aspect, setAspect] = useState<CropAspect>('1:1');
  const [x, setX] = useState(50);
  const [y, setY] = useState(50);
  const [state, setState] = useState<{ busy: boolean; error: string }>({ busy: false, error: '' });
  const id = `crop-${asset.id}`;
  const shape = CROP_SHAPES.find((c) => c.aspect === aspect)!;
  const largest = asset.thumbnailUrl?.replace(
    /\/\d+\.webp$/,
    `/${asset.widths[asset.widths.length - 1] ?? 400}.webp`,
  );
  return (
    <div className="space-y-2 rounded-md border border-slate-200 bg-slate-50 p-3">
      <label htmlFor={`${id}-shape`} className="block text-xs font-medium">
        Shape
      </label>
      <select
        id={`${id}-shape`}
        className="block rounded-md border border-slate-300 bg-white px-2 py-1 text-sm"
        value={aspect}
        onChange={(e) => setAspect(e.target.value as CropAspect)}
      >
        {CROP_SHAPES.map((c) => (
          <option key={c.aspect} value={c.aspect}>
            {c.label}
          </option>
        ))}
      </select>
      <div
        className="w-48 overflow-hidden rounded border border-slate-300 bg-white"
        style={{ aspectRatio: shape.css }}
      >
        {largest ? (
          <img
            src={largest}
            alt=""
            className="h-full w-full object-cover"
            style={{ objectPosition: `${x}% ${y}%` }}
            data-testid="crop-preview"
          />
        ) : null}
      </div>
      <label htmlFor={`${id}-x`} className="block text-xs font-medium">
        Left to right
      </label>
      <input
        id={`${id}-x`}
        type="range"
        min={0}
        max={100}
        value={x}
        onChange={(e) => setX(Number(e.target.value))}
      />
      <label htmlFor={`${id}-y`} className="block text-xs font-medium">
        Top to bottom
      </label>
      <input
        id={`${id}-y`}
        type="range"
        min={0}
        max={100}
        value={y}
        onChange={(e) => setY(Number(e.target.value))}
      />
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className={button}
          disabled={state.busy}
          onClick={async () => {
            setState({ busy: true, error: '' });
            const result = await library.crop(asset.id, { aspect, x, y });
            if (result.ok) onDone(`Saved as ${result.asset.fileName}.`);
            else setState({ busy: false, error: result.error });
          }}
        >
          {state.busy ? 'Saving…' : 'Save as new image'}
        </button>
        <button type="button" className={button} onClick={() => onDone('')}>
          Cancel
        </button>
      </div>
      {state.error ? (
        <p role="alert" className="text-xs text-red-700">
          {state.error}
        </p>
      ) : null}
    </div>
  );
}

/** "Add image" for a list of images (a gallery): opens the library and appends the chosen one. */
export function AddImageButton({
  label,
  disabled,
  onAdd,
}: {
  label: string;
  disabled: boolean;
  onAdd: (image: ImageRef) => void;
}) {
  const library = useLibrary();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className={button} disabled={disabled || !library} onClick={() => setOpen(true)}>
        Add image<span className="sr-only"> to {label.toLowerCase()}</span>
      </button>
      <ImagePicker open={open} onClose={() => setOpen(false)} onPick={onAdd} />
    </>
  );
}

/** "shop-front_2.jpg" -> "Shop front 2": a starting description the person is asked to check. */
export function altFromFileName(fileName: string): string {
  const base = fileName
    .replace(/\.[a-z0-9]{2,5}$/i, '')
    .replace(/[-_.]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const text = base ? base.charAt(0).toUpperCase() + base.slice(1) : 'Photo';
  return text.slice(0, 200);
}
