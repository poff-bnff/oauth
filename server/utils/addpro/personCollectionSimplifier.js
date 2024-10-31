export async function simplifyPersonCollection(person, user = null, extended = true) {
    const simplifiedObject = {
        id: person.id,
        firstName: person.firstName,
        lastName: person.lastName,
        orderedRaF: formatOrderedRaF(person.orderedRaF),
        h_rate_from: person.h_rate_from,
        h_rate_to: person.h_rate_to,
        gender: getObjectId(person.gender),
        native_lang: getObjectId(person.native_lang),
        other_lang: person.other_lang.map(language => language.id),
        profile_img: formatMedia(person.profile_img),
        skills_en: person.skills_en,
        bio_en: person.bio_en,
        tag_looking_fors: person.tag_looking_fors.map(looking_for => looking_for.id),

        webpage_url: person.webpage_url,
        acc_imdb: person.acc_imdb,
        acc_efis: person.acc_efis,
        acc_instagram: person.acc_instagram,
        acc_fb: person.acc_fb,
        acc_other: person.acc_other,
        acc_youtube: person.acc_youtube,
        acc_vimeo: person.acc_vimeo,
        acc_etalenta: person.acc_etalenta,
        acc_castupload: person.acc_castupload,


        acting_age_from: person.acting_age_from,
        acting_age_to: person.acting_age_to,
        weight_kg: person.weight_kg,
        height_cm: person.height_cm,
        eye_colour: getObjectId(person.eye_colour),
        hair_colour: getObjectId(person.hair_colour),
        hair_length: getObjectId(person.hair_length),
        pitch_of_voice: getObjectId(person.pitch_of_voice),
        stature: getObjectId(person.stature),

        festival_editions: person.festival_editions.map(festival_edition => festival_edition.id),

        phoneNr: person.phoneNr,
        eMail: person.eMail,

        addr_coll: formatAddressFields(person.addr_coll),
        filmographies: await formatFilmographies(person.filmographies),

        showreel: person.showreel,
        audioreel: formatMedia(person.audioreel),
        images: formatImages(person.images),
        slug_en: person.slug_en
    }

    if (user !== null) {
        simplifiedObject['ok_to_contact'] = user.ok_to_contact
    }

    if (extended) {
        simplifiedObject['filmographies'] = await formatFilmographies(person.filmographies);
    }
    return simplifiedObject
}

function getObjectId(data) {
    if(!data) {
        return data
    }

    return data.id
}

function formatAddressFields(addr_coll)
{
    if (!addr_coll) {
        return addr_coll
    }
    return {
        id: addr_coll.id,
        country: addr_coll.country,
        county: addr_coll.county,
        municipality: addr_coll.municipality,
        add_county: addr_coll.add_county,
        add_municipality: addr_coll.add_municipality,
        popul_place: addr_coll.popul_place,
        street_name: addr_coll.street_name,
        appartment: addr_coll.appartment,
        postal_code: addr_coll.postal_code,
        address_number: addr_coll.address_number,
    }
}

function formatMedia(image) {
    if (!image) {
        return image
    }
    return {
        id: image.id,
        caption: image.caption,
        hash: image.hash,
        ext: image.ext,
    }
}
function formatImages(images) {
    return images.map(image => formatMedia(image))
}

function formatOrderedRaF(orderedRaF) {
    return orderedRaF.filter(ordered_role_at_film => ordered_role_at_film.role_at_film).map(ordered_role_at_film => {
        return {
            id: ordered_role_at_film.id,
            order: ordered_role_at_film.order,
            role_at_film: {id: ordered_role_at_film.role_at_film.id}
        }
    });
}

async function formatFilmographies(originalFilmographies) {

    if (!originalFilmographies.length) {
        return [];
    }
    const filmographiesIds = originalFilmographies.map(function (element) {
        return element.id;
    });

    const filmographies = await getStrapiFilmographies(filmographiesIds)
    return filmographies.map(filmography => {
        return {
            id: filmography.id,
            work_name: filmography.work_name,
            work_url: filmography.work_url,
            decsription_en: filmography.decsription_en,
            org_name: filmography.org_name,
            org_department: filmography.org_department,
            degree: filmography.degree,
            org_url: filmography.org_url,
            runtime: filmography.runtime,
            year_from: filmography.year_from,
            year_to: filmography.year_to,
            url: filmography.url,
            is_featured: filmography.is_featured,
            type_of_work: filmography.type_of_work?.id,
            is_ongoing: filmography.is_ongoing,
            role_at_films: filmography.role_at_films.map(role_at_film => role_at_film.id),
            project_statuses: filmography.project_statuses.map(project_status => project_status.id),
            tag_looking_fors: filmography.tag_looking_fors.map(tag_looking_for => tag_looking_for.id),
            stills: filmography.stills.map(still => {
                return {
                    id: still.id,
                    hash: still.hash,
                    ext: still.ext
                }
            })
        }
    })
}
