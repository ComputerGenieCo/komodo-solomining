// Helper functions
async function httpRequest(req) {
    return new Promise((resolve, reject) => {
        const request = new XMLHttpRequest();
        request.open('GET', req);
        request.onload = function () {
            if (request.status >= 200 && request.status < 400) {
                resolve(request.responseText);
            } else {
                reject(request.status);
            }
        };
        request.onerror = function () { reject("Couldn't get the data :("); };
        request.send();
    });
}

function groupBy(xs, key) {
    return xs.reduce((rv, x) => {
        (rv[x[key]] = rv[x[key]] || []).push(x);
        return rv;
    }, {});
}

// Main function to handle blocks  
async function fetchBlocks() {
    try {
        const json = await httpRequest("/blocks.json");
        const array = JSON.parse(json); // Sample: [{"block":48759,"finder":"rx480","date":1490404074912},{"block":48760,"finder":"rx470","date":1490404148117}]
        const groupedByFinder = groupBy(array, 'finder');

        await Promise.all([
            renderFinderInfoTable(groupedByFinder, array.length),
            renderBlocksTable(array),
            renderBlocksChart(groupedByFinder)
        ]);

        return "fetchBlocks() completed";
    } catch (err) {
        console.error("Error fetching blocks:", err);
        throw err;
    }
}

// Function to create finder info table
async function renderFinderInfoTable(groupedByFinder, arrayLength) {
    const tablediv = document.getElementById('info');
    const table = document.createElement('table');
    const thead = document.createElement('thead');
    const tbody = document.createElement('tbody');
    table.className = 'table table-hover table-striped';

    const theadTR = document.createElement('tr');
    const theadTH1 = document.createElement('th');
    const theadTH2 = document.createElement('th');
    theadTH1.appendChild(document.createTextNode('Finder'));
    theadTH2.appendChild(document.createTextNode('Blocks of ' + arrayLength));
    theadTR.appendChild(theadTH1);
    theadTR.appendChild(theadTH2);
    thead.appendChild(theadTR);
    table.appendChild(thead);

    const fragment = document.createDocumentFragment();
    Object.keys(groupedByFinder).forEach(i => {
        const row = document.createElement("tr");
        const cell1 = document.createElement("td");
        const cell2 = document.createElement("td");
        cell1.appendChild(document.createTextNode(i));
        cell2.appendChild(document.createTextNode(groupedByFinder[i].length));
        row.appendChild(cell1);
        row.appendChild(cell2);
        fragment.appendChild(row);
    });
    tbody.appendChild(fragment);
    table.appendChild(tbody);
    tablediv.appendChild(table);
}

// Function to create blocks table
async function renderBlocksTable(array) {
    const tablediv = document.getElementById('blocks');
    const table = document.createElement('table');
    const thead = document.createElement('thead');
    const tbody = document.createElement('tbody');
    table.className = 'table table-hover table-striped';

    const theadTR = document.createElement('tr');
    const theadTH1 = document.createElement('th');
    const theadTH2 = document.createElement('th');
    const theadTH3 = document.createElement('th');
    theadTH1.appendChild(document.createTextNode('Block'));
    theadTH2.appendChild(document.createTextNode('Finder'));
    theadTH3.appendChild(document.createTextNode('Date'));
    theadTR.appendChild(theadTH1);
    theadTR.appendChild(theadTH2);
    theadTR.appendChild(theadTH3);
    thead.appendChild(theadTR);
    table.appendChild(thead);

    const fragment = document.createDocumentFragment();
    for (let i = array.length; i--;) {
        const row = document.createElement("tr");
        const cell1 = document.createElement("td");
        const cell2 = document.createElement("td");
        const cell3 = document.createElement("td");
        cell1.appendChild(document.createTextNode(''));
        const link = document.createElement('a');
        link.href = args[1] + "/block-index/" + array[i].block;
        link.setAttribute("target", "_blank");
        link.innerText = array[i].block;
        cell1.appendChild(link);
        cell2.appendChild(document.createTextNode(array[i].finder));

        const d = new Date(array[i].date);
        cell3.appendChild(document.createTextNode(d));
        row.appendChild(cell1);
        row.appendChild(cell2);
        row.appendChild(cell3);
        fragment.appendChild(row);
    }
    tbody.appendChild(fragment);
    table.appendChild(tbody);
    tablediv.appendChild(table);
}

// Function to create blocks chart
async function renderBlocksChart(data) {
    const container = document.getElementById('info');
    const containerWidth = container.offsetWidth;
    const pieHeight = 280; // Height of actual pie
    const svgHeight = 340; // Increased overall height for padding
    const pieWidth = pieHeight;
    const width = containerWidth;
    const radius = Math.min(pieWidth, pieHeight) / 2;

    // Calculate legend width based on data
    const maxLabelLength = Math.max(...Object.keys(data).map(k => (k + ' (' + data[k].length + ')').length));
    const legendWidth = maxLabelLength * 8 + 40; // Approximate pixels per character plus padding
    const totalChartWidth = pieWidth + legendWidth;

    // Calculate centering offset
    const centerOffset = (width - totalChartWidth) / 2;

    d3.select("#piechart").selectAll("*").remove();
    const svg = d3.select("#piechart")
        .append("svg")
        .attr("width", width)
        .attr("height", svgHeight) // Use larger height for SVG
        .append("g")
        .attr("transform", `translate(${centerOffset + pieWidth / 2},${svgHeight / 2})`); // Center in larger space

    const color = d3.scaleOrdinal()
        .domain(Object.keys(data))
        .range(d3.schemeSet3);

    const pie = d3.pie()
        .value(d => d[1].length);

    const data_ready = pie(Object.entries(data));

    // Create pie slices
    svg.selectAll('path')
        .data(data_ready)
        .join('path')
        .attr('d', d3.arc()
            .innerRadius(0)
            .outerRadius(radius)
        )
        .attr('fill', d => color(d.data[0]))
        .attr("stroke", "var(--chart-stroke)")
        .style("stroke-width", "2px");

    // Create legend with centered position
    const legend = svg.append("g")
        .attr("transform", `translate(${radius + 20}, ${-Object.keys(data).length * 12})`);

    legend.selectAll("legend")
        .data(data_ready)
        .join("g")
        .attr("transform", (d, i) => `translate(0, ${i * 25})`)
        .call(g => {
            g.append("rect")
                .attr("width", 15)
                .attr("height", 15)
                .attr("fill", d => color(d.data[0]));

            g.append("text")
                .attr("x", 25)
                .attr("y", 12)
                .text(d => `${d.data[0]} (${d.data[1].length})`)
                .style("font-size", "1rem")
                .style("font-family", "inherit")
                .style("fill", "var(--chart-text)");
        });
}

// Main script execution 
const args = document.currentScript.dataset.args.split(',');
document.addEventListener("DOMContentLoaded", async () => {
    try {
        await fetchBlocks();
    } catch (err) {
        console.error(err);
    }
});
