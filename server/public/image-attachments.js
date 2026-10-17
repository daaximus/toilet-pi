export const MAX_IMAGES = 4;
export const MAX_IMAGE_BYTES = 512 * 1024;
export const MAX_SOURCE_BYTES = 20 * 1024 * 1024;
export const IMAGE_MIME_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];

export function isImageAttachment(image) {
	if (!image || image.type !== "image" || !IMAGE_MIME_TYPES.includes(image.mimeType) || typeof image.data !== "string") return false;
	const data = image.data;
	if (!data.length || data.length > 4 * Math.ceil(MAX_IMAGE_BYTES / 3) || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) return false;
	return data.length / 4 * 3 - (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0) <= MAX_IMAGE_BYTES;
}

export function validImageAttachments(images) {
	return images === undefined || (Array.isArray(images) && images.length <= MAX_IMAGES && images.every(isImageAttachment));
}

export function getMessageImages(content) {
	if (!Array.isArray(content)) return undefined;
	const images = content.filter(isImageAttachment).slice(0, MAX_IMAGES).map(({ type, mimeType, data }) => ({ type, mimeType, data }));
	return images.length ? images : undefined;
}

export function userMessageContent(text, images) {
	if (!validImageAttachments(images)) throw new Error("Invalid images: use up to 4 JPEG, PNG, WebP or GIF images, at most 512 KiB each");
	return images?.length ? [...(text ? [{ type: "text", text }] : []), ...images] : text;
}

function readDataUrl(file) {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(String(reader.result));
		reader.onerror = () => reject(new Error("Could not read image"));
		reader.onabort = () => reject(new Error("Image reading was cancelled"));
		reader.readAsDataURL(file);
	});
}

export async function prepareImage(file) {
	if (!IMAGE_MIME_TYPES.includes(file.type)) throw new Error(`${file.name}: choose JPEG, PNG, WebP or GIF (export HEIC as JPEG first)`);
	if (!file.size || file.size > MAX_SOURCE_BYTES) throw new Error(`${file.name}: image must be between 1 byte and 20 MiB`);
	const url = await readDataUrl(file);
	// Decode even small files so corrupt or renamed non-images are rejected.
	const image = new Image();
	image.src = url;
	await image.decode().catch(() => { throw new Error(`${file.name}: this browser could not decode the image`); });
	if (file.size <= MAX_IMAGE_BYTES) return { type: "image", mimeType: file.type, data: url.split(",")[1] };
	const canvas = document.createElement("canvas");
	let scale = Math.min(1, 1600 / Math.max(image.naturalWidth, image.naturalHeight));
	for (let attempt = 0; attempt < 5; attempt++, scale *= 0.75) {
		canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
		canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
		const context = canvas.getContext("2d");
		if (!context) throw new Error("Image resizing is not available in this browser");
		context.fillStyle = "white";
		context.fillRect(0, 0, canvas.width, canvas.height);
		context.drawImage(image, 0, 0, canvas.width, canvas.height);
		const result = { type: "image", mimeType: "image/jpeg", data: canvas.toDataURL("image/jpeg", 0.85).split(",")[1] };
		if (isImageAttachment(result)) return result;
	}
	throw new Error(`${file.name}: could not resize below 512 KiB`);
}

export function appendImages(root, images) {
	if (!Array.isArray(images) || !images.length) return;
	const gallery = document.createElement("div");
	gallery.className = "message-images";
	for (const attachment of images.slice(0, MAX_IMAGES)) {
		if (!isImageAttachment(attachment)) continue;
		const image = document.createElement("img");
		image.src = `data:${attachment.mimeType};base64,${attachment.data}`;
		image.alt = "Attached image";
		image.loading = "lazy";
		gallery.append(image);
	}
	root.append(gallery);
}

export function createImageComposer({ picker, button, previews, report }) {
	let images = [];
	let preparing = false;
	function render() {
		previews.replaceChildren();
		previews.hidden = images.length === 0;
		images.forEach((image, index) => {
			const item = document.createElement("div");
			item.className = "attachment-preview";
			appendImages(item, [image]);
			const remove = document.createElement("button");
			remove.type = "button";
			remove.textContent = `Remove image ${index + 1}`;
			remove.disabled = preparing;
			remove.onclick = () => { images.splice(index, 1); render(); };
			item.append(remove);
			previews.append(item);
		});
		button.disabled = preparing;
		button.textContent = preparing ? "Reading…" : "Attach";
	}
	button.onclick = () => picker.click();
	picker.onchange = async () => {
		const files = [...picker.files];
		picker.value = "";
		if (!files.length) return;
		if (images.length + files.length > MAX_IMAGES) { report("Attach up to 4 images per message", "error"); return; }
		preparing = true;
		render();
		try {
			// Commit the whole selection only after every file succeeds.
			const added = [];
			for (const file of files) added.push(await prepareImage(file));
			images.push(...added);
			report("Images ready. Large images are resized to 512 KiB; large GIFs become still images.", "info");
		} catch (error) { report(error.message || "Could not attach images", "error"); }
		finally { preparing = false; render(); }
	};
	return {
		getImages: () => images.slice(),
		isPreparing: () => preparing,
		clear: () => { images = []; render(); },
	};
}
