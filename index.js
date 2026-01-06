const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const multer = require('multer');
const xlsx = require('xlsx');
const path = require('path');
const fs = require('fs');

const app = express();
const port = process.env.PORT || 3000;

// Configuración de la Base de Datos
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

app.use(cors());
app.use(express.json());

// --- FRONTEND ---
const rutaPublic = path.join(__dirname, 'public');
const rutaRaiz = __dirname;

app.use(express.static(rutaPublic));
app.use(express.static(rutaRaiz));

app.get('/', (req, res) => {

    const archivoPublic = path.join(rutaPublic, 'index.html');

    if (fs.existsSync(archivoPublic)) res.sendFile(archivoPublic);
    else res.sendFile(path.join(rutaRaiz, 'index.html'));
});

// ================= API ROUTES =================

// 1. BUSCAR MATERIALES
app.get('/api/materiales', async (req, res) => {
    try {
        const query = req.query.q || ''; 
        const sql = "SELECT * FROM materiales WHERE nombre ILIKE $1 OR codigo_1 ILIKE $1 ORDER BY id DESC LIMIT 100";
        const result = await pool.query(sql, [`%${query}%`]);
        res.json(result.rows);
    } catch (err) { console.error(err); res.status(500).send(err.message); }
});

// 2. CREAR COTIZACIÓN
app.post('/api/cotizaciones', async (req, res) => {
    try {
        const { nombre_proyecto, cliente, valor_dia_mo, dias_trabajados, cantidad_personas, margen_general } = req.body;
        const result = await pool.query(
            "INSERT INTO cotizaciones (nombre_proyecto, cliente, valor_dia_mo, dias_trabajados, cantidad_personas, margen_general) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id",
            [nombre_proyecto, cliente, valor_dia_mo, dias_trabajados, cantidad_personas, margen_general]
        );
        res.json(result.rows[0]);
    } catch (err) { console.error(err); res.status(500).send(err.message); }
});

// 3. AGREGAR ITEM
app.post('/api/items', async (req, res) => {
    try {
        const { cotizacion_id, material_id, cantidad, precio_congelado } = req.body;
        await pool.query("INSERT INTO items_cotizacion (cotizacion_id, material_id, cantidad, precio_congelado) VALUES ($1, $2, $3, $4)", [cotizacion_id, material_id, cantidad, precio_congelado]);
        res.json({ message: "Item agregado" });
    } catch (err) { console.error(err); res.status(500).send(err.message); }
});

// 4. HISTORIAL
app.get('/api/historial', async (req, res) => {
    try {
        const result = await pool.query("SELECT * FROM cotizaciones ORDER BY id DESC LIMIT 50");
        res.json(result.rows);
    } catch (err) { console.error(err); res.status(500).send(err.message); }
});

// 5. CARGAR ITEMS DE UN PROYECTO
app.get('/api/proyecto/:id/items', async (req, res) => {
    try {
        const { id } = req.params;
        const sql = `SELECT i.*, m.nombre, m.valor_int, m.valor_normal FROM items_cotizacion i JOIN materiales m ON i.material_id = m.id WHERE i.cotizacion_id = $1`;
        const result = await pool.query(sql, [id]);
        res.json(result.rows);
    } catch (err) { console.error(err); res.status(500).send(err.message); }
});

// 6. ELIMINAR COTIZACIÓN
app.delete('/api/cotizaciones/:id', async (req, res) => {
    try {
        const { id } = req.params;

        await pool.query("DELETE FROM items_cotizacion WHERE cotizacion_id = $1", [id]);

        await pool.query("DELETE FROM cotizaciones WHERE id = $1", [id]);

        res.json({ message: "Eliminado correctamente" });
    } catch (err) { console.error(err); res.status(500).send(err.message); }
});

// 7. SUBIR EXCEL
const upload = multer({ storage: multer.memoryStorage() });
app.post('/api/upload-excel', upload.single('file'), async (req, res) => {
    try {
        const workbook = xlsx.read(req.file.buffer, { type: 'buffer' });
        const sheetName = workbook.SheetNames[0];
        const data = xlsx.utils.sheet_to_json(workbook.Sheets[sheetName]);

        let contador = 0;
        for (const row of data) {

            const nombre = row['nombre'] || row['Nombre'] || row['Descripcion'];
            const precio = row['valor_int'] || row['Precio'] || row['Valor Int.'];
            const codigo = row['codigo_1'] || row['Codigo'];
            const unidad = row['unidad'] || row['UN.'] || 'C/u';
            const valorNormal = row['valor_normal'] || row['Valor Normal'] || 0;
            const marca = row['marca'] || row['Marca'] || 'Genérico';
            if (nombre && precio) {

                await pool.query(
                    "INSERT INTO materiales (nombre, unidad, codigo_1, valor_int, valor_normal, marca) VALUES ($1, $2, $3, $4, $5, $6)",
                    [nombre, unidad, codigo, precio, valorNormal, marca]
                );
                contador++;
            }
        }
        res.json({ message: `✅ Importados: ${contador}` });
    } catch (err) { console.error(err); res.status(500).send(err.message); }
});

// 8. CREAR MATERIAL MANUAL
app.post('/api/materiales/nuevo', async (req, res) => {
    try {
        const { nombre, marca, codigo, unidad, valor_int, valor_normal } = req.body;
        if (!nombre || !valor_int) return res.status(400).json({ message: "Faltan datos" });
        await pool.query(
            "INSERT INTO materiales (nombre, marca, codigo_1, unidad, valor_int, valor_normal) VALUES ($1, $2, $3, $4, $5, $6)",
            [nombre, marca || 'Genérico', codigo || '', unidad || 'Un.', valor_int, valor_normal || 0]
        );
        res.json({ message: "✅ Material creado" });
    } catch (err) { console.error(err); res.status(500).send(err.message); }
});

// 9. ELIMINAR MATERIAL (NUEVO) 🗑️
app.delete('/api/materiales/:id', async (req, res) => {
    try {
        const { id } = req.params;
        await pool.query("DELETE FROM materiales WHERE id = $1", [id]);
        res.json({ message: "Material eliminado" });
    } catch (err) {
        // Si el error es por llave foránea (código 23503), es porque está en uso
        if (err.code === '23503') {
            res.status(400).send("⚠️ No se puede eliminar: Este material está siendo usado en una cotización antigua.");
        } else {
            console.error(err);
            res.status(500).send("Error al eliminar material");
        }
    }
});

app.listen(port, () => console.log(`Server en puerto ${port}`));