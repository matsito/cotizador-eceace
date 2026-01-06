const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const multer = require('multer');
const xlsx = require('xlsx');
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;

// Configuración de la Base de Datos
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

app.use(cors());
app.use(express.json());

// --- LA SOLUCIÓN AL "NOT FOUND" ---
// Esto le dice al servidor: "Sirve cualquier archivo que encuentres aquí (index.html, css, etc)"
app.use(express.static(__dirname));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});
// ----------------------------------

// --- API ROUTES ---

// 1. Buscar Materiales
app.get('/api/materiales', async (req, res) => {
    try {
        const query = req.query.q || '';
        const result = await pool.query(
            "SELECT * FROM materiales WHERE nombre ILIKE $1 OR codigo_1 ILIKE $1 LIMIT 50", 
            [`%${query}%`]
        );
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).send("Error buscando materiales");
    }
});

// 2. Crear Cotización
app.post('/api/cotizaciones', async (req, res) => {
    try {
        const { nombre_proyecto, cliente, valor_dia_mo, dias_trabajados, cantidad_personas, margen_general } = req.body;
        const result = await pool.query(
            "INSERT INTO cotizaciones (nombre_proyecto, cliente, valor_dia_mo, dias_trabajados, cantidad_personas, margen_general) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id",
            [nombre_proyecto, cliente, valor_dia_mo, dias_trabajados, cantidad_personas, margen_general]
        );
        res.json(result.rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).send("Error creando cotización");
    }
});

// 3. Agregar Item
app.post('/api/items', async (req, res) => {
    try {
        const { cotizacion_id, material_id, cantidad, precio_congelado } = req.body;
        await pool.query(
            "INSERT INTO items_cotizacion (cotizacion_id, material_id, cantidad, precio_congelado) VALUES ($1, $2, $3, $4)",
            [cotizacion_id, material_id, cantidad, precio_congelado]
        );
        res.json({ message: "Item agregado" });
    } catch (err) {
        console.error(err);
        res.status(500).send("Error agregando item");
    }
});

// 4. Subir Excel
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

            if (nombre && precio) {
                await pool.query(
                    "INSERT INTO materiales (nombre, unidad, codigo_1, valor_int, valor_normal) VALUES ($1, $2, $3, $4, $5)",
                    [nombre, unidad, codigo, precio, valorNormal]
                );
                contador++;
            }
        }
        res.json({ message: `✅ ${contador} productos importados correctamente` });
    } catch (err) {
        console.error(err);
        res.status(500).send("Error procesando Excel");
    }
});

app.listen(port, () => {
    console.log(`Servidor corriendo en el puerto ${port}`);
});