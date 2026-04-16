const HUBSPOT_TOKEN = process.env.HUBSPOT_TOKEN;
const HUBSPOT_ACCOUNT_ID = process.env.HUBSPOT_ACCOUNT_ID;

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();

  const { contact_id, import_code, list_name, list_id } = req.body;
  if (!contact_id || !import_code || !list_name) {
    return res.status(400).json({ error: "Champs manquants: contact_id, import_code, list_name" });
  }

  try {
    let listId = list_id ? parseInt(list_id) : null;
    let listJustCreated = false;

    // ── 1. Si Clay fournit déjà le listId, on l'utilise directement ─────────
    if (!listId) {

      // ── 2. Cherche par query + pagination ──────────────────────────────────
      async function findListByName(name) {
        let offset = 0;
        while (true) {
          const res = await fetch(
            `https://api.hubapi.com/contacts/v1/lists?count=250&offset=${offset}&query=${encodeURIComponent(name)}`,
            { headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}` } }
          );
          const data = await res.json();
          const found = data.lists?.find(l => l.name?.trim() === name?.trim());
          if (found) return found;
          if (!data["has-more"]) break;
          offset += 250;
        }
        return null;
      }

      const existing = await findListByName(list_name);
      if (existing) {
        listId = existing.listId;
        console.log("Found existing list:", listId);
      } else {
        // ── 3. Crée la liste ────────────────────────────────────────────────
        const createRes = await fetch("https://api.hubapi.com/contacts/v1/lists", {
          method: "POST",
          headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}`, "Content-Type": "application/json" },
          body: JSON.stringify({ name: list_name, dynamic: false })
        });
        const created = await createRes.json();
        console.log("Create status:", createRes.status, JSON.stringify(created));

        if (createRes.status === 200) {
          listId = created.listId;
          listJustCreated = true;
          console.log("Created listId:", listId);
        } else if (createRes.status === 400 || createRes.status === 409) {
          // Race condition — retry
          for (let attempt = 1; attempt <= 5 && !listId; attempt++) {
            await new Promise(r => setTimeout(r, attempt * 1500));
            const found = await findListByName(list_name);
            if (found) {
              listId = found.listId;
              console.log(`Refetched listId (attempt ${attempt}):`, listId);
            }
          }
        } else {
          throw new Error("List creation failed: " + JSON.stringify(created));
        }
      }
    } else {
      console.log("Using listId from Clay:", listId);
    }

    if (!listId) throw new Error("Impossible de récupérer le listId");

    // ── 4. Ajoute le contact ────────────────────────────────────────────────
    console.log("Adding contact", contact_id, "to listId:", listId);
    const addRes = await fetch(`https://api.hubapi.com/contacts/v1/lists/${listId}/add`, {
      method: "POST",
      headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ vids: [parseInt(contact_id)] })
    });
    const addText = await addRes.text();
    console.log("Add status:", addRes.status, addText.substring(0, 200));

    // ── 5. URL + webhook Clay à la création ────────────────────────────────
    const list_url = `https://app.hubspot.com/contacts/${HUBSPOT_ACCOUNT_ID}/lists/${listId}`;

    if (listJustCreated) {
      await fetch("https://api.clay.com/v3/sources/webhook/pull-in-data-from-a-webhook-8bbd1005-a299-4e85-9387-08701e82a8ea", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ import_code, list_name, list_id: listId, list_url, status: "list_created" })
      });
      console.log("Clay webhook sent for new list:", list_name);
    }

    return res.status(200).json({ success: true, list_id: listId, list_url });

  } catch (err) {
    console.error("Error:", err.message);
    return res.status(500).json({ error: err.message });
  }
}
