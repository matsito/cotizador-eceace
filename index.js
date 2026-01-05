const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const path = require('path');
const multer = require('multer'); // <--- Nueva librería
const xlsx = require('xlsx');     // <--- Nueva librería
require('dotenv').config();

const app = express();
const upload = multer({ storage: multer.memoryStorage() }); // Configuración para subir archivos en memoria

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const pool = new Pool({
    connectionString: process.env.DATABASE_URL || `postgresql://${process.env.DB_USER}:${process.env.DB_PASSWORD}@${process.env.DB_HOST}:${process.env.DB_PORT}/${process.env.DB_NAME}`,
    ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

// --- RUTAS DE MATERIALES ---
app.get('/materiales', async (req, res) => {
    try {
        const resultado = await pool.query('SELECT * FROM materiales ORDER BY id DESC');
        res.json(resultado.rows);
    } catch (e) { res.status(500).send(e.message); }
});

app.post('/materiales', async (req, res) => {
    const { nombre, marca, codigo_1, codigo_2, unidad, valor_int, valor_normal } = req.body;
    try {
        await pool.query(
            'INSERT INTO materiales (nombre, marca, codigo_1, codigo_2, unidad, valor_int, valor_normal) VALUES ($1, $2, $3, $4, $5, $6, $7)',
            [nombre, marca, codigo_1, codigo_2, unidad, valor_int, valor_normal]
        );
        res.json({ mensaje: 'Material guardado' });
    } catch (e) { res.status(500).send(e.message); }
});

// (NUEVO) RUTA PARA IMPORTAR EXCEL MASIVO
app.post('/importar-excel', upload.single('archivoExcel'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'No se subió ningún archivo' });

        // 1. Leer el Excel desde la memoria
        const workbook = xlsx.read(req.file.buffer, { type: 'buffer' });
        const sheetName = workbook.SheetNames[0]; // Leemos la primera hoja
        const sheet = workbook.Sheets[sheetName];
        
        // 2. Convertir a JSON (Lista de objetos)
        const datos = xlsx.utils.sheet_to_json(sheet);

        // 3. Insertar uno por uno en la base de datos
        let cont = 0;
        for (const item of datos) {
            // Validamos que tenga al menos nombre y precio
            if (item.nombre && item.valor_int) {
                await pool.query(
                    'INSERT INTO materiales (nombre, marca, codigo_1, codigo_2, unidad, valor_int, valor_normal) VALUES ($1, $2, $3, $4, $5, $6, $7)',
                    [
                        item.nombre, 
                        item.marca || null, 
                        item.codigo_1 || null, 
                        item.codigo_2 || null, 
                        item.unidad || 'c/u', 
                        item.valor_int, 
                        item.valor_normal || 0
                    ]
                );
                cont++;
            }
        }

        res.json({ mensaje: `✅ Se importaron ${cont} materiales correctamente.` });

    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'Error al procesar el Excel. Revisa el formato.' });
    }
});

app.delete('/materiales/:id', async (req, res) => {
    try {
        await pool.query('DELETE FROM materiales WHERE id = $1', [req.params.id]);
        res.json({ mensaje: 'Material eliminado' });
    } catch (e) { res.status(500).json({ error: 'No se puede borrar: Este material ya está en una cotización.' }); }
});

// --- RUTAS DE COTIZACIONES ---
app.post('/cotizaciones', async (req, res) => {
    const { nombre_proyecto, cliente, valor_dia_mo, dias, personas, margen_mat, margen_mo, margen_gg } = req.body;
    try {
        const result = await pool.query(
            `INSERT INTO cotizaciones (nombre_proyecto, cliente, valor_dia_mo, dias_trabajados, cantidad_personas, margen_materiales, margen_mo, margen_general) 
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
            [nombre_proyecto, cliente, valor_dia_mo, dias, personas, margen_mat, margen_mo, margen_gg]
        );
        res.json({ id: result.rows[0].id, mensaje: 'Proyecto creado' });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/cotizaciones/:id', async (req, res) => {
    const id = req.params.id;
    try {
        await pool.query('DELETE FROM items_cotizacion WHERE cotizacion_id = $1', [id]);
        await pool.query('DELETE FROM cotizaciones WHERE id = $1', [id]);
        res.json({ mensaje: 'Proyecto eliminado correctamente' });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/cotizaciones/:id/items', async (req, res) => {
    const { material_id, cantidad, precio_congelado } = req.body;
    try {
        await pool.query(
            `INSERT INTO items_cotizacion (cotizacion_id, material_id, cantidad, precio_congelado) 
             VALUES ($1, $2, $3, $4)`,
            [req.params.id, material_id, cantidad, precio_congelado]
        );
        res.json({ mensaje: 'Item agregado' });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/items/:id', async (req, res) => {
    try {
        await pool.query('DELETE FROM items_cotizacion WHERE id = $1', [req.params.id]);
        res.json({ mensaje: 'Item eliminado' });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/todas-las-cotizaciones', async (req, res) => {
    try {
        const resultado = await pool.query('SELECT * FROM cotizaciones ORDER BY id DESC');
        res.json(resultado.rows);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/cotizaciones/:id', async (req, res) => {
    const id = req.params.id;
    try {
        const proyecto = await pool.query('SELECT * FROM cotizaciones WHERE id = $1', [id]);
        if (proyecto.rows.length === 0) return res.status(404).json({ error: 'Proyecto no encontrado' });

        const items = await pool.query(
            `SELECT i.*, m.nombre, m.marca, m.unidad, m.codigo_1 
             FROM items_cotizacion i 
             JOIN materiales m ON i.material_id = m.id 
             WHERE i.cotizacion_id = $1 ORDER BY i.id ASC`, [id]
        );

        const p = proyecto.rows[0];
        const mg_mat = parseFloat(p.margen_materiales || 18);
        const mg_mo  = parseFloat(p.margen_mo || 25);
        const mg_gg  = parseFloat(p.margen_general || 20);

        let costoDirectoMateriales = 0;
        items.rows.forEach(item => {
            costoDirectoMateriales += (parseFloat(item.precio_congelado) * parseFloat(item.cantidad));
        });

        const costoDirectoMO = parseFloat(p.valor_dia_mo) * parseInt(p.dias_trabajados) * parseInt(p.cantidad_personas);
        
        const ventaMateriales = costoDirectoMateriales * (1 + (mg_mat/100));
        const ventaMO = costoDirectoMO * (1 + (mg_mo/100));
        const totalNetoSinGG = ventaMateriales + ventaMO;
        const totalFinalNeto = totalNetoSinGG * (1 + (mg_gg/100));
        const utilidadReal = totalFinalNeto - (costoDirectoMateriales + costoDirectoMO);

        res.json({
            proyecto: p,
            items: items.rows,
            resumen: {
                costo_materiales: Math.round(costoDirectoMateriales),
                costo_mo: Math.round(costoDirectoMO),
                venta_materiales: Math.round(ventaMateriales),
                venta_mo: Math.round(ventaMO),
                total_neto: Math.round(totalFinalNeto),
                utilidad_real: Math.round(utilidadReal),
                margenes: { mat: mg_mat, mo: mg_mo, gg: mg_gg }
            }
        });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Servidor listo en puerto ${PORT}`));