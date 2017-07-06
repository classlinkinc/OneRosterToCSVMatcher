var oAuth = require('oauth-1.0a'),
	crypto = require('crypto'),
	request = require('supertest'),
	config = require('./config.js'),
	fs = require('fs'),
	parse = require('csv-parse'),
	async = require('async'),
	readline = require('readline');

let string = "username, sourcedId, identifier, email\nYour input: ";

//Create the read interface.
var read = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

//Ask for user input
read.question("Enter name of CSV file in " + process.cwd() + "\nYour input: ", (fileName) => {

	//Add .csv extension if the user didn't
	if (!fileName.includes(".csv")) fileName += ".csv";

	var filePath = process.cwd() + '//' + fileName;

	//Check if file exists
	if (fs.existsSync(filePath)) {
			console.log("Found file");
	}
	else {
		console.log("Did not find file");
		closeStreams();
		return;
	}

	//Parse the CSV file and get the Data from OneRoster before continuing
	console.log("Fetching data from server... this could take a minute.");
	Promise.all([parseCSV(filePath), requestAllORData()]).then(allData => {
		console.log("Data succesfully retrived");

		//All CSV Data
		let csv = allData[0];

		//All OneRoster Data
		let oneRoster = allData[1];
		
		//Get the oneRoster Filter
		read.question("Filter OneRoster by one of the following: " + string + " ", (orFilter) => {
			
			let string = "";

			for (let title of csv[0])
			{
				string += title + ", ";
			}

			string += '\nYour input: ';

			//Get the CSV Filter
			read.question("Filter CSV by one of the following: " + string, (csvFilter) => {

				//OneRoster will return data sorted by sourcedId, sort the CSV by first property.
				sortedCSV = sortCSV(csv);
				generateCSVs(oneRoster, sortedCSV, orFilter, csvFilter);
				closeStreams();
			});
		});

	});

});

//Closes the streams for readLine so the process can terminate.
function closeStreams() {
	read.close();
	process.stdin.destroy();
	process.exit();
}

//Send all requests to OneRoster simultaneously and returns one array containing all the data.
function requestAllORData() {

	let offset = 0;
	var allData = [];

	//Create one promise to return all data
	return new Promise((resolve, reject) => {

		//Make the initial call to get data
		getOneRosterData(offset).then(data => {

			let totalCount = parseInt(data.total);
			let amtReturned = parseInt(data.count);
			allData.push(...data.body.users);

			//If we didn't fetch all the data:
			if (totalCount > amtReturned) {

				//Loop through and create a new promise to retrieve data in order
				(function loop(offset) {
					new Promise((resolve, reject) => {
						getOneRosterData(offset).then(data => {
							allData.push(...data.body.users);
							offset += parseInt(data.count);
							resolve();
						});
					}).then(() => {
						//Check if we retrieved all data
						if (offset < totalCount) loop(offset);
						else {
							//If so return the array
							resolve(allData);
						} 
							
					});
					//Pass the looping function the initial amount of data we receieved.
				})(amtReturned);
			}
			else {
				//Resolve the first promise with the data
				resolve(allData);
			}

		});
	});
}

//Query the oneRoster API using oAuth and the appropriate properties set in config.js
function getOneRosterData(offset)  {

	const CONFIG_LIMIT = 10000;

	config.params = "?limit=" + (config.limit || CONFIG_LIMIT) + "&offset=" + (offset || 0) + "&orderBy=asc";

	return new Promise((resolve, reject) => {

		if (config.limit > CONFIG_LIMIT) {
		reject(new Error("Limit cannot be > " + CONFIG_LIMIT));
	} 
		//creates object used to make oauth signature
		let oauth = oAuth({
			consumer: {
				key: config.key,
				secret: config.secret
			},
			signature_method: 'HMAC-SHA256',
			hash_function: function(base_string, key) {
				return crypto.createHmac('sha256', key).update(base_string).digest('base64');
			}
		});

		//create base request
		var req = request(config.baseURL);

		//data used to make header
		let requestData = {
			url: config.baseURL + config.ending + config.params,
			method: 'GET'
		};

		//oauth header
		let header = oauth.toHeader(oauth.authorize(requestData));

		//request
		req.get(config.ending + config.params)
		.set('Accept', 'application/json')
		.set(header)
		.expect('Content-Type', /json/)
		.expect(200)
		.end(function(err, data) {
			if (err) {
				console.log("Ensure URL, key, and secret are set in config.js");
				reject(new Error(err));
			}
			else {
				resolve({"body": data.body, "count": data.headers["x-returned-count"], "total": data.headers["x-total-count"]});
			}
		});
	});
}

//Parses the CSV in inputFile into an array of arrays based on line.
function parseCSV(inputFile) {

	return new Promise((resolve, reject) => {
		var parser = parse({delimiter: ','}, function (err, data) {
			if (err) {
				console.log("Ensure validity of the CSV file.")
				reject(new Error(err));
			}
			else resolve(data);
		});

		fs.createReadStream(inputFile).pipe(parser);
	});
	
}

//Sort the csv by the first property, in this case sourcedId as it should be unique	
function sortCSV(csv) {

	//Remove headers line
	var firstLine = csv.shift();

	var comparator = function(line1, line2) {
		return (line1[0] < line2[0]) ? -1 : 1;
	}

	//Sort without headers
	csv.sort(comparator);

	//Readd headers to front
	csv.unshift(firstLine);

	return csv;
}

//Creates the CSVs and writes them to files
function generateCSVs(oneRosterData, parsedCSV, orFilter, csvFilter) {

	//Get the headers
	let headers = parsedCSV.shift();
	let orHeaders = Object.keys(oneRosterData[0]);

	//Get what index the specific property is located at in the array
	let csvPropIndex = getIndexOfFilter(headers, csvFilter);
	let orPropIndex = getIndexOfFilter(orHeaders, orFilter);

	//If one was not found, return
	if (csvPropIndex === undefined)
	{
		console.log("Bad CSV Filter");
		return;
	}
	if (orPropIndex === undefined)
	{
		console.log("Bad One Roster Filter");
		return;
	}

	//Change the oneRosterData from an array of objects to an array of arrays
	oneRosterData = convertToArr(oneRosterData);

	//Get the matches
	let matches = getMatches(oneRosterData, parsedCSV, orPropIndex, csvPropIndex);

	//Get what's exclusive to only OR and only CSV
	let onlyOR = notInMatches(matches, oneRosterData, csvPropIndex, orPropIndex);
	let onlyCSV = notInMatches(matches, parsedCSV, csvPropIndex, csvPropIndex);

	console.log("Writing to files...");

	//Write the data to files.
	writeToFile("./matches.csv", headers, matches);
	writeToFile("./notInCSV.csv", orHeaders, onlyOR);
	writeToFile("./notInOR.csv", headers, onlyCSV);

	console.log("Files written to " + process.cwd());

}

//Convert an array of objects to an array of arrays
function convertToArr(arrOfObjs)
{	
	var finalArray = [];

	//For each object in the array, convert to an array and push to the outer array
	for (let current of arrOfObjs) {
		var array = Object.keys(current).map(key => current[key]);
		finalArray.push(array);
	}

	return finalArray;
}

//Get the index in the array of headers of 'filter', or undefined if not found
function getIndexOfFilter(headersArr, filter) {
	let csvFilter = filter.toLowerCase();
	for (let index = 0; index < headersArr.length; index++)
	{
		if (csvFilter == headersArr[index].toLowerCase()) return index;
	}

	return undefined;
}

//Compare oneRosterData to the parsedCSV on the fields specified by orPropIndex and csvPropIndex
function getMatches(oneRosterData, parsedCSV, orPropIndex, csvPropIndex) {
	let matches = [];

	orLength = oneRosterData.length;
	csvLength = parsedCSV.length;

	for (var orIndex = 0; orIndex < orLength; orIndex++) {

		//Get the current person's data by property index 
		let current = oneRosterData[orIndex][orPropIndex];

		for (var csvIndex = 0; csvIndex < csvLength; csvIndex++) {

			//If the person's data in one roster matches this data in the CSV, there is a match
			if (current == parsedCSV[csvIndex][csvPropIndex]){

				matches.push(parsedCSV[csvIndex]);
				break;
			}
		}
	}
	

	return matches;
}

//Check what entries in dataSet are not in matches based on the 
//properties specified by inMatchesIndex and inDataSetIndex
function notInMatches(matches, dataSet, inMatchesIndex, inDataSetIndex) {

	let notInMatches = [];

	for (var dIndex = 0; dIndex < dataSet.length; dIndex++) {

		//Get current property in dataset
		let current = dataSet[dIndex][inDataSetIndex];
		let found = false;
		
		//Check if it matches any of the properties in matches
		for (var mIndex = 0; mIndex < matches.length; mIndex++) {

			let currMatch = matches[mIndex][inMatchesIndex];

			//If found a match, break.
			if (currMatch == current) {

				found = true;
				break;
			}
		}

		//If it wasn't found, add to notInMatches
		if (!found) notInMatches.push(dataSet[dIndex]);
	}
	
	return notInMatches;

}

//Write the headers then the data to the filepath as a CSV.
function writeToFile(filePath, headers, data) {

	let string = "";

	string += headers + '\n';

	for (let entry of data) {
		for (let item in entry) {
			//If current item in the line is considered an object, we must stringify it.
			if (typeof entry[item] === "object") {
				//We are using a CSV, so replace any commas with semi-colons to prevent confusion
				entry[item] = JSON.stringify(entry[item]).replace(/,/g, ";");
			}
		}
		string += entry + '\n';
	}

	fs.writeFileSync(filePath, string);
}


