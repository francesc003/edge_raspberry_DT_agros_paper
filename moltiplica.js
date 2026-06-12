const fs = require('fs');

// Imposta qui il numero di nodi per il tuo test di scalabilità
const NUMERO_NODI = 50; 

// Percorso del file hardware
const filePath = './digital-twin/profiles/hardware_profile_campo_raspberry_01.json';

try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    
    // Prende i primi 10 nodi come base da clonare
    const templateNodes = data.nodi.slice(0, 10);
    const newNodes = [];

    // Crea i nodi richiesti
    for (let i = 1; i <= NUMERO_NODI; i++) {
        // Clona uno dei nodi originali ciclicamente
        let node = JSON.parse(JSON.stringify(templateNodes[(i - 1) % 10]));
        
        // Genera il nuovo progressivo (es. 01, 02 ... 50)
        let numStr = i.toString().padStart(2, '0');
        
        // Aggiorna gli ID per renderli unici
        node.node_id = `campo_raspberry_01_node_${numStr}`;
        node.posizione.descrizione = `Nodo ${i} di ${NUMERO_NODI}, per test scalabilità`;
        
        // Aggiorna gli ID dei sensori (es. da N01_AT a N50_AT)
        node.sensori.forEach(s => {
            let suffisso = s.id.split('_')[1]; 
            s.id = `N${numStr}_${suffisso}`;
        });
        
        newNodes.push(node);
    }

    // Sovrascrive i nodi nel file e salva
    data.nodi = newNodes;
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));

    console.log(`✅ File JSON aggiornato con successo! Ora il profilo contiene ${NUMERO_NODI} nodi.`);

} catch (error) {
    console.error("❌ Errore: Impossibile trovare o modificare il file.");
    console.error("Assicurati di lanciare lo script dalla cartella che contiene la sottocartella 'digital-twin'.");
    console.error("Dettaglio errore:", error.message);
}