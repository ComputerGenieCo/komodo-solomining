// Helper functions
async function httpRequest(req) {
    return new Promise((resolve, reject) => {
        const request = new XMLHttpRequest();
        request.open('GET', req);
        request.onload = function() {
            if (request.status >= 200 && request.status < 400) {
                resolve(request.responseText);
            } else {
                reject(request.status);
            }
        };
        request.onerror = function() { reject("Couldn't get the data :("); };
        request.send();
    });
}

function groupBy(xs, key) {
    return xs.reduce((rv, x) => {
        (rv[x[key]] = rv[x[key]] || []).push(x);
        return rv;
    }, {});
}

function done(func) {
    //console.log(func + " is done");
}

// Main function to handle blocks
async function fetchBlocks(cback) {
    try {
        const json = await httpRequest("/blocks.json");
        const array = JSON.parse(json); // Sample: [{"block":48759,"finder":"rx480","date":1490404074912},{"block":48760,"finder":"rx470","date":1490404148117}]
        const groupedByFinder = groupBy(array, 'finder');

        await Promise.all([
            renderFinderInfoTable(groupedByFinder, array.length),
            renderBlocksTable(array),
            renderBlocksChart(groupedByFinder)
        ]);

        cback("fetchBlocks() completed");
    } catch (err) {
        console.error("Error fetching blocks:", err);
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
    const array = [];
    const svgwidth = 1000;
    const width = 360;
    const height = 360;
    const radius = Math.min(width, height) / 2;
    const color = d3.scaleOrdinal(d3.schemeCategory20c);

    Object.keys(data).forEach(i => {
        const obj = {};
        obj.label = i;
        obj.value = data[i].length;
        array.push(obj);
    });

    const legendRectSize = 18;
    const legendSpacing = 5;

    const svg = d3.select('#piechart')
                .append('svg')
                .attr('width', svgwidth)
                .attr('height', height)
                .append('g')
                .attr('transform', 'translate(' + (width / 2) + ',' + (height / 2) + ')');

    const arc = d3.arc()
                .innerRadius(0)
                .outerRadius(radius);

    const pie = d3.pie().value(d => d.value).sort(null);

    const path = svg.selectAll('path')
                .data(pie(array))
                .enter()
                .append('path')
                .attr('d', arc)
                .attr('fill', (d, i) => color(d.data.label));

    const legend = svg.selectAll('.legend')
                    .data(color.domain())
                    .enter()
                    .append('g')
                    .attr('class', 'legend')
                    .attr('transform', (d, i) => {
                        const height = legendRectSize + legendSpacing;
                        const offset = height * color.domain().length / 2;
                        const horz = 12 * legendRectSize;
                        const vert = i * height;
                        return 'translate(' + horz + ',' + vert + ')';
                    });

    legend.append('rect')
        .attr('width', legendRectSize)
        .attr('height', legendRectSize)
        .style('fill', color)
        .style('stroke', color);

    legend.append('text')
        .attr('x', legendRectSize + legendSpacing)
        .attr('y', legendRectSize - legendSpacing)
        .text((d, i) => array[i].label);
}

// Main script execution
const args = document.currentScript.dataset.args.split(',');
document.addEventListener("DOMContentLoaded", () => { fetchBlocks(done); });
